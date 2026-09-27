"""スマホ用 Web 版サーバー（標準ライブラリのみ）。

  python web_server.py                 セーブ web があれば再開、無ければ新規
  python web_server.py --port 8770     ポート指定（既定 8770）
  python web_server.py --host 127.0.0.1  PC だけで遊ぶとき

iPhone からは http://<PCのIP または Tailscale 名>:8770/ を Safari で開く。
ゲームの中身は Game をそのまま使い、画面描画だけを web/ の HTML/JS が行う。
相手の HP・種族値・捕獲率・相性倍率・シードは送らない（相手 HP は 48 段階の比率だけ）。
"""
import argparse
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mrpg.battle import STAGE_NAMES, WEATHER_NAMES, ActionError  # noqa: E402
from mrpg.game import STARTERS, Game  # noqa: E402
from mrpg.logger import PlayLogger  # noqa: E402
from mrpg.monster import STATS, STATUS_NAMES, exp_for_level  # noqa: E402
from mrpg.render import world_view  # noqa: E402  たびの地図（CLI・MCP と共通）

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
SLOT = "web"
HP_STEPS = 48  # 相手 HP は画面のバーと同じ粒度でしか送らない
DIR_KEYS = {(0, -1): "up", (0, 1): "down", (-1, 0): "left", (1, 0): "right"}
WEB_WORDS = {"answer_prompt": "選択", "battle_action": "コマンド", "interact で": "A ボタンで",
             "interact": "A ボタン"}


def web_text(s):
    for k, v in WEB_WORDS.items():
        s = s.replace(k, v)
    return s


CAT_NAMES = {"phys": "物理", "spec": "特殊", "status": "変化"}


def move_desc(mv):
    """技の説明文（ゲーム内の説明と同じ粒度。確率の数字は出さず「ことがある」で表す）"""
    out = []
    for ef in mv.get("effects") or []:
        k, maybe = ef.get("kind"), "ことがある" if ef.get("chance", 100) < 100 else ""  # 戦闘の判定と同じ（100 は必ず）
        if k == "status":
            out.append(f"相手を {STATUS_NAMES.get(ef['status'], ef['status'])}状態に する{maybe}。")
        elif k == "confuse":
            out.append(f"相手を 混乱させる{maybe}。")
        elif k == "stat":
            who = "自分" if ef.get("target") == "self" else "相手"
            for st, n in ef.get("stats", {}).items():
                how = ("大きく " if abs(n) >= 2 else "") + ("上げる" if n > 0 else "下げる")
                out.append(f"{who}の {STAGE_NAMES.get(st, st)}を {how}{maybe}。")
        elif k == "weather":
            out.append(f"しばらく {WEATHER_NAMES.get(ef['weather'], ef['weather'])}状態にする。")
        elif k == "heal":
            out.append(f"自分の HPを {'半分' if ef.get('ratio') == 0.5 else '一部'} 回復する。")
    if mv.get("crit"):
        out.append("急所に 当たりやすい。")
    if mv.get("priority", 0) > 0:
        out.append("相手より 先に 攻撃できる。")
    elif mv.get("priority", 0) < 0:
        out.append("相手より 後に 出る。")
    if not out:
        out.append("ふつうに 攻撃する。" if mv.get("cat") != "status" else "特別な 効果は ない。")
    return "".join(out)


def move_view(g, mv):
    md = g.data.moves[mv["id"]]
    return {"name": md["name"], "type": md["type"], "pp": mv["pp"], "max_pp": md["pp"],
            "cat": CAT_NAMES.get(md.get("cat"), md.get("cat")),
            "power": md.get("power") if md.get("cat") != "status" else None,
            "acc": md.get("acc"), "desc": move_desc(md)}


def mon_view(g, m, idx=None):
    d = {"name": m.name, "species": m.species, "level": m.level, "types": list(m.types), "hp": m.hp,
         "max_hp": m.maxhp, "status": m.status_label() or None, "shiny": bool(m.shiny),
         "moves": [move_view(g, mv) for mv in m.moves]}
    # 自分のモンスターの能力値と性格（個体値・努力値そのものは出さない）
    d["stats"] = {k: m.stat(k) for k in STATS if k != "hp"}
    nat = g.data.natures[m.nature]
    d["nature"] = {"name": nat["name"], "up": nat.get("up"), "down": nat.get("down")}
    if m.level < 100:  # 自分のモンスターの経験値バー（割合だけ）
        lo = exp_for_level(m.sp["growth"], m.level)
        hi = exp_for_level(m.sp["growth"], m.level + 1)
        d["exp_ratio"] = round(max(0.0, min(1.0, (m.exp - lo) / max(1, hi - lo))), 3)
    else:
        d["exp_ratio"] = 1.0
    if idx is not None:
        d["index"] = idx
    return d


def enemy_view(m):
    """相手は数値を出さない。HP は 48 段階の比率のみ"""
    ratio = 0 if m.hp <= 0 else max(1, round(HP_STEPS * m.hp / m.maxhp))
    return {"name": m.name, "species": m.species, "level": m.level, "types": list(m.types),
            "hp_steps": ratio, "hp_steps_max": HP_STEPS, "status": m.status_label() or None,
            "shiny": bool(m.shiny)}


def battle_view(g):
    b = g.battle
    if not b:
        return None
    d = {"kind": b.kind, "state": b.state, "turn": b.turn, "weather": b.weather,
         "player_index": b.p_idx, "enemy_index": b.e_idx, "enemy": enemy_view(b.enemy),
         "enemy_team": [0 if m.fainted else 1 for m in b.enemies]}
    if b.trainer_id:
        d["trainer"] = {"id": b.trainer_id, "name": g.data.trainers[b.trainer_id]["name"]}
    return d


def prompt_payload(g):
    p = g.prompt_view()
    if not p:
        return None
    p = dict(p, text=web_text(p["text"]))
    if p["kind"] == "starter":
        p["species"] = list(STARTERS)
    if p["kind"] in ("learn_move", "evolve"):
        mon = g.party[g.prompts[0]["party"]]
        p["species"] = mon.species
        p["party"] = g.prompts[0]["party"]
        if p["kind"] == "evolve":
            p["into"] = (mon.sp.get("evolve") or {}).get("into")
    if p["kind"] == "shop":
        p["items"] = [{"id": i, "name": g.data.items[i]["name"], "price": g.data.items[i]["price"],
                       "desc": g.data.items[i].get("desc", ""), "kind": g.data.items[i]["kind"],
                       "have": g.items.get(i, 0)} for i in g.shop_items()]
        bonus = g.data.shop_bonus
        if bonus:
            p["bonus"] = {"kind": bonus["kind"], "per": bonus["per"], "name": g.data.items[bonus["gift"]]["name"]}
    if p["kind"] == "box":
        p["box"] = [mon_view(g, m, i) for i, m in enumerate(g.box)]
    return p


def clock_view(g):
    """たびの手帳の時計: いまの時間帯と、次の時間帯まで あと何歩か"""
    t = g.data.config["time"]
    per, ph = t["steps_per_phase"], t["phases"]
    return {"phases": ph, "index": (g.steps // per) % len(ph), "left": per - g.steps % per, "per": per}


def dex_payload(data):
    """見た目の生成に使う公開情報だけ（名前・タイプ・進化系統）。種族値や捕獲率は出さない"""
    parent = {}
    for sid, sp in data.species.items():
        into = (sp.get("evolve") or {}).get("into")
        if into:
            parent[into] = sid
    out = {}
    for sid, sp in data.species.items():
        root, stage = sid, 0
        while root in parent:
            root, stage = parent[root], stage + 1
        out[sid] = {"name": sp["name"], "types": list(sp["types"]), "line": root, "stage": stage,
                    "no": sp.get("no")}
    moves = {mv["name"]: mv["type"] for mv in data.moves.values()}
    return {"species": out, "moves": moves}


def area_view(g):
    a = g.area
    def who(o):  # 見た目を決める鍵（トレーナー・道場主はバトル時と同じ人に見せる）
        if o["kind"] == "trainer":
            return {"trainer": o["trainer"]}
        if o["kind"] == "gym":
            return {"trainer": next(t for t, v in g.data.trainers.items() if v.get("boss") and v["town"] == o["town"])}
        return {}
    objs = [{"x": o["x"], "y": o["y"], "kind": o["kind"], "label": o.get("label", ""), **who(o),
             **{k: o[k] for k in ("building", "person") if k in o}}
            for o in a["objects"] if g.object_visible(o)]
    return {"id": g.area_id, "name": a["name"], "cave": bool(a.get("cave")), "interior": bool(a.get("interior")),
            "weather": a.get("weather"),
            "map": a["map"], "objects": objs, "blocked": a.get("blocked", []),
            "unlocked": [ch for ch in ("R", "T", "~") if g.unlocked(ch)]}


def frame_view(f):
    """戦闘メッセージ1件ぶんの画面状態。相手の HP は比率だけ"""
    if not f:
        return None
    ratio = 0 if f["e_hp"] <= 0 else max(1, round(HP_STEPS * f["e_hp"] / f["e_max"]))
    return {"p_idx": f["p_idx"], "p_hp": f["p_hp"], "p_max": f["p_max"], "p_status": f["p_status"],
            "e_idx": f["e_idx"], "e_steps": ratio, "e_status": f["e_status"]}


def make_out(g, req, msgs, err):
    out = {"messages": [web_text(m) for m in msgs], "state": state_payload(g)}
    if req.get("op") == "battle" and not err:
        fr = getattr(g, "last_frames", None) or []
        if len(fr) == len(msgs):  # 1件ずつ HP・状態を合わせる（ずれていたら従来どおり最後にまとめて）
            out["frames"] = [frame_view(f) for f in fr]
    if err:
        out["error"] = web_text(err)
    return out


def state_payload(g):
    return {
        "area": area_view(g),
        "player": {"x": g.x, "y": g.y, "facing": DIR_KEYS[tuple(g.facing)]},
        "phase": g.phase(),
        "money": g.money,
        "medals": [g.data.medals[t]["name"] for t in g.medals],
        "medal_total": len(g.data.medals),
        "party": [mon_view(g, m, i) for i, m in enumerate(g.party)],
        "box_count": len(g.box),
        "items": [{"id": k, "name": g.data.items[k]["name"], "kind": g.data.items[k]["kind"],
                   "desc": g.data.items[k].get("desc", ""), "count": v}
                  for k, v in sorted(g.items.items()) if v > 0],
        # 図鑑: 見た・捕まえた種族の一覧と、捕まえた種族の説明文だけ（種族値などは出さない）
        "dex": {"seen": len(g.seen), "caught": len(g.caught),
                "seen_ids": sorted(g.seen), "caught_ids": sorted(g.caught),
                "entries": {sid: g.data.species[sid].get("dex", "") for sid in sorted(g.caught)},
                "habitats": {sid: g.habitats(sid) for sid in sorted(g.seen | g.caught)}},
        "world": world_view(g) if g.items.get("tabichizu", 0) > 0 else None,
        "steps": g.steps,
        "clock": clock_view(g),
        "obey_cap": g.obey_cap(),
        "battle": battle_view(g),
        "prompt": None if g.battle else prompt_payload(g),
        "warning": g.stuck_warning(),
        "intro_seen": "web_intro_seen" in g.flags,
        "wakeai_on": g.wakeai_active(),
        "player_name": g.player_name,
    }


class Session:
    """1 台の PC で 1 つのゲームを持つ。操作ごとに slot=web へ自動セーブ"""

    def __init__(self, slot=SLOT):
        self.slot = slot
        self.lock = threading.Lock()
        self.logger = PlayLogger("web")
        try:
            self.game = Game.load(slot, logger=self.logger)
        except ActionError:
            self.game = Game("normal", logger=self.logger)

    def dispatch(self, req):
        op = req.get("op")
        g = self.game
        if op == "state":
            return []
        if op == "intro_seen":  # はじめの説明を見終えた（次から出さない）
            g.flags.add("web_intro_seen")
            return []
        if op == "new":
            # 名前つきで はじめる時は、先に名前を確かめる（だめなら 今のセーブは そのまま残す）
            name = Game.clean_name(req["name"]) if "name" in req else None
            mode = "experiment" if req.get("seed") is not None else "normal"
            self.game = Game(mode, seed=req.get("seed"), logger=self.logger)
            if name is not None:
                self.game.set_name(name)
            return ["新しい冒険を はじめた。"]
        if op == "set_name":  # プレイヤー名を 決める・変える
            return g.set_name(req.get("name"))
        if op == "move":
            return g.move(req.get("direction"), 1)
        if op == "interact":
            return g.interact()
        if op == "battle":
            action = req.get("action")
            if not isinstance(action, dict):
                raise ActionError("行動の形が正しくない")
            return g.battle_action(dict(action))
        if op == "prompt":
            return g.answer_prompt(req.get("index"), req.get("count", 1))
        if op == "item":
            return g.use_item(req.get("item"), req.get("target"))
        if op == "order":
            return g.reorder_party(req.get("order") or [])
        if op == "box":
            return g.box_action(req.get("action"), req.get("party"), req.get("box"))
        raise ActionError("知らない操作")

    def handle(self, req):
        with self.lock:
            try:
                msgs = self.dispatch(req)
                err = None
            except ActionError as e:
                msgs, err = [], str(e)
            if req.get("op") not in ("state",):
                self.logger.action("web", {k: v for k, v in req.items()}, "", msgs + ([f"({err})"] if err else []))
                self.game.save(self.slot)
            return make_out(self.game, req, msgs, err)


def make_handler(session):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MonsterRPG/1"

        def log_message(self, fmt, *args):  # 標準エラーを汚さない
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/state":
                return self._json(200, session.handle({"op": "state"}))
            if path == "/api/dex":
                return self._json(200, dex_payload(session.game.data))
            if path == "/":
                path = "/index.html"
            full = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
            if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(full):
                return self._send(404, b"not found", "text/plain; charset=utf-8")
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".webmanifest"):
                ctype = "application/manifest+json"
            if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                self._send(200, f.read(), ctype)

        def do_POST(self):
            if self.path != "/api/act":
                return self._send(404, b"not found", "text/plain; charset=utf-8")
            n = int(self.headers.get("Content-Length") or 0)
            if n > 10000:
                return self._json(413, {"error": "too large"})
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
                if not isinstance(req, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {"error": "JSON が読めない"})
            self._json(200, session.handle(req))

    return Handler


def make_server(host="0.0.0.0", port=8770, slot=SLOT):
    return ThreadingHTTPServer((host, port), make_handler(Session(slot)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    srv = make_server(args.host, args.port)
    print(f"Monster RPG Web: http://localhost:{args.port}/  （iPhone は http://<PCのIP>:{args.port}/ ）")
    print("止めるときは Ctrl+C（毎手 自動セーブ済み）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
