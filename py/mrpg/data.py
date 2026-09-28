"""data/*.json の読み込みと参照整合チェック。数値はすべて JSON 側に置く。"""
import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def _load(name):
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def _load_optional(name, default):
    """無くても動くファイル（差し替え画像の表 等）"""
    if not os.path.isfile(os.path.join(DATA_DIR, name)):
        return default
    return _load(name)


# 建物の室内（町の建物オブジェクトから生成する。'D' は家具＝通れない）
INTERIOR_MAPS = {
    "heal": ["###########", "#DD.....DD#", "#.........#", "#...DDD...#", "#.........#",
             "#D.......D#", "#.........#", "#####.#####"],
    "shop": ["###########", "#DDD...DDD#", "#.........#", "#...DDD...#", "#.........#",
             "#DD.....DD#", "#.........#", "#####.#####"],
    "lab": ["###########", "#DDDD.DDDD#", "#.........#", "#.........#", "#D.......D#",
            "#D.......D#", "#.........#", "#####.#####"],
    "gym": ["###########", "#D...D...D#", "#.........#", "#..D...D..#", "#.........#",
            "#..D...D..#", "#.........#", "#D.......D#", "#.........#", "#####.#####"],
}
STAFF_LABEL = {"heal": "休み処の おかみ", "shop": "店番", "lab": "博士"}
# 町の建物が占めるマス（入口 (x,y) からの相対 dy の範囲。横は x-1..x+1）。入口以外は通れない＝正面からしか入れない
FOOTPRINT_DY = {"heal": (-1, 0), "shop": (-1, 0), "lab": (-1, 0), "gym": (-2, 0)}
BOX_OBJ = {"x": 8, "y": 2, "kind": "box", "label": "あずかり箱"}
RIVAL_NPC = {"x": 7, "y": 3, "kind": "npc", "label": "{rival}", "person": "rival", "hide_flag": "rival_1_done",  # {rival} は 表示の 直前に Game.fmt で 置き換える
             "text": "おそいぞ！ 博士が 待ちくたびれてるぜ。おれは もう 相棒を 決めてあるんだ"}


def _add_interiors(areas):
    for town in [k for k, a in areas.items() if not a.get("interior")]:
        a = areas[town]
        for i, o in enumerate(a["objects"]):
            kind = o["kind"]
            if kind not in INTERIOR_MAPS:
                continue
            m = INTERIOR_MAPS[kind]
            iid, h, door = f"{town}_{kind}", len(m), m[-1].index(".")
            staff = dict(o, x=door, y=2, person=kind,
                         label=o["label"] if kind == "gym" else STAFF_LABEL[kind])
            staff.pop("inside", None)
            objs = [{"x": door, "y": h - 1, "kind": "exit", "to": town, "tx": o["x"], "ty": o["y"] + 1}, staff]
            objs += [dict(x) for x in o.get("inside", [])]  # 建物の中に置く NPC（助手・書庫係 等）
            if kind == "lab":
                objs.append(dict(RIVAL_NPC))
            if kind == "heal":
                objs.append(dict(BOX_OBJ))
            lo, hi = FOOTPRINT_DY[kind]
            blocked = a.setdefault("blocked", [])
            for yy in range(o["y"] + lo, o["y"] + hi + 1):
                for xx in (o["x"] - 1, o["x"], o["x"] + 1):
                    if (xx, yy) != (o["x"], o["y"]) and [xx, yy] not in blocked:
                        blocked.append([xx, yy])
            areas[iid] = {"name": o["label"], "interior": True, "parent": town, "map": m,
                          "encounters": [], "objects": objs}
            a["objects"][i] = {"x": o["x"], "y": o["y"], "kind": "exit", "building": kind, "label": o["label"],
                               "to": iid, "tx": door, "ty": h - 2}


class GameData:
    def __init__(self):
        t = _load("types.json")
        self.types = t["types"]
        self.chart = t["chart"]
        self.moves = _load("moves.json")["moves"]
        self.species = _load("species.json")["species"]
        it = _load("items.json")
        self.items = it["items"]
        self.shop_tiers = it["shop_tiers"]["tiers"]
        self.shop_bonus = it.get("shop_bonus")
        self.pickup = it["pickup"]
        self.config = _load("config.json")
        self.natures = _load("natures.json")["natures"]
        ar = _load("areas.json")
        self.areas = ar["areas"]
        self.world_map = ar.get("world_map", {"cells": {}})
        self.planned_places = ar.get("planned_places", [])  # 地図が未実装の場所名（その場所の進化は今は起きない）
        _add_interiors(self.areas)
        tr = _load("trainers.json")
        self.trainers = tr["trainers"]
        self.medals = tr["medals"]
        # 関門の文字 → その関門を開けるメダルの町（岩・茂み・水・暗闇・重い扉・電気の柵・崖・吹雪 等）
        self.gates = {md["unlocks"]: town for town, md in self.medals.items() if md.get("unlocks")}
        self.images = _load_optional("images.json", {}).get("images", {})  # id → web/ からの画像パス（無い種族は手描き）
        self.intro = _load_optional("intro.json", {})  # 博士の 導入（台詞・博士の名前・名前の候補）。書き換えは intro.json だけで済む

    EVOLVE_METHODS = ("level", "friendship", "time", "place", "move", "move_type", "item", "held_item")

    def place_names(self):
        """進化条件の place に書いてよい名前（地図のある場所の place_tags ＋ 地図が未実装の planned_places）"""
        names = set(self.planned_places)
        for a in self.areas.values():
            names.update(a.get("place_tags", []))
        return names

    def _validate_evolve(self, sid, ev):
        errs = []
        if ev.get("into") not in self.species:
            errs.append(f"species {sid}: unknown evolve target {ev.get('into')}")
        method = ev.get("method", "level")
        if method not in self.EVOLVE_METHODS:
            errs.append(f"species {sid}: unknown evolve method {method}")
        if method == "level" and ev.get("level") is None:
            errs.append(f"species {sid}: level evolve without level")
        if method in ("item", "held_item") and ev.get("item") not in self.items:
            errs.append(f"species {sid}: unknown evolve item {ev.get('item')}")
        if ev.get("item") and self.items.get(ev["item"], {}).get("kind") != "evolution":
            errs.append(f"species {sid}: evolve item {ev.get('item')} is not kind=evolution")
        if ev.get("move") and ev["move"] not in self.moves:
            errs.append(f"species {sid}: unknown evolve move {ev['move']}")
        if ev.get("move_type") and ev["move_type"] not in self.types:
            errs.append(f"species {sid}: unknown evolve move_type {ev['move_type']}")
        if ev.get("time") and ev["time"] not in self.config.get("time", {}).get("phases", []):
            errs.append(f"species {sid}: unknown evolve time {ev['time']}")
        if ev.get("place") and ev["place"] not in self.place_names():
            errs.append(f"species {sid}: unknown evolve place {ev['place']}")
        return errs

    def _validate_need(self, where, cond):
        """need_* 条件（出口・出てくる物・NPC・話のフラグ・さすらい）の 型と参照"""
        errs = []
        if cond.get("need_medal") and cond["need_medal"] not in self.medals:
            errs.append(f"{where}: unknown medal {cond['need_medal']}")
        for k in ("need_medals", "need_dex"):
            if k in cond and not (isinstance(cond[k], int) and cond[k] >= 0):
                errs.append(f"{where}: bad {k} {cond[k]!r}")
        if "need_flag" in cond and not (isinstance(cond["need_flag"], str) and cond["need_flag"]):
            errs.append(f"{where}: bad need_flag {cond['need_flag']!r}")
        nf = cond.get("need_flags")
        if nf is not None and not (isinstance(nf, list) and all(isinstance(f, str) and f for f in nf)):
            errs.append(f"{where}: need_flags must be a list of flag names")
        return errs

    def _validate_special(self, aid, o):
        """交換・もらうモンスター・固定シンボル・落ちている道具の参照チェック"""
        errs = []
        lab = o.get("label")
        tr = o.get("trade")
        if tr:
            for k in ("give", "get"):
                if tr.get(k) not in self.species:
                    errs.append(f"area {aid}: trade unknown species {tr.get(k)} {lab}")
            for k in ("id", "level", "text_offer", "text_ask", "text_done"):
                if not tr.get(k):
                    errs.append(f"area {aid}: trade missing {k} {lab}")
            if tr.get("need_medal") and tr["need_medal"] not in self.medals:
                errs.append(f"area {aid}: trade unknown medal {tr['need_medal']}")
        gm = o.get("gift_monster")
        if gm:
            for k in ("id", "level", "text_give"):
                if not gm.get(k):
                    errs.append(f"area {aid}: gift_monster missing {k} {lab}")
            if gm.get("choose") != "starters" and gm.get("species") not in self.species:
                errs.append(f"area {aid}: gift_monster unknown species {gm.get('species')} {lab}")
            if (gm.get("need_dex") or gm.get("need_medals")) and not gm.get("text_before"):
                errs.append(f"area {aid}: gift_monster missing text_before {lab}")
        if o["kind"] == "static":
            if o.get("species") not in self.species:
                errs.append(f"area {aid}: static unknown species {o.get('species')}")
            if not o.get("flag") or not o.get("level"):
                errs.append(f"area {aid}: static missing flag/level {lab}")
        if o["kind"] == "item":
            if o.get("item") not in self.items:
                errs.append(f"area {aid}: unknown field item {o.get('item')}")
            if not o.get("flag"):
                errs.append(f"area {aid}: field item missing flag {o}")
        return errs

    def type_mult(self, atk_type, def_types):
        m = 1.0
        row = self.chart.get(atk_type, {})
        for d in def_types:
            m *= row.get(d, 1.0)
        return m

    def validate(self):
        """参照切れを列挙する（空リストなら整合）"""
        errs = []
        for sid, s in self.species.items():
            for t in s["types"]:
                if t not in self.types:
                    errs.append(f"species {sid}: unknown type {t}")
            for lv, mv in s["learnset"]:
                if mv not in self.moves:
                    errs.append(f"species {sid}: unknown move {mv}")
            ev = s.get("evolve")
            if ev:
                errs += self._validate_evolve(sid, ev)
            if len(s["base"]) != 6:
                errs.append(f"species {sid}: base must have 6 values")
        for mid, m in self.moves.items():
            if m["type"] not in self.types:
                errs.append(f"move {mid}: unknown type {m['type']}")
        for need, lst in self.shop_tiers:
            for i in lst:
                if i not in self.items:
                    errs.append(f"shop tier {need}: unknown item {i}")
        if self.shop_bonus and self.shop_bonus["gift"] not in self.items:
            errs.append(f"shop_bonus: unknown gift {self.shop_bonus['gift']}")
        for i, _ in self.pickup["table"]:
            if i not in self.items:
                errs.append(f"pickup: unknown item {i}")
        for aid, a in self.areas.items():
            h = len(a["map"])
            for row in a["map"]:
                if len(row) != len(a["map"][0]):
                    errs.append(f"area {aid}: ragged map")
                    break
            w = len(a["map"][0])
            gift = a.get("arrive_gift")
            if gift and gift["item"] not in self.items:
                errs.append(f"area {aid}: unknown gift item {gift['item']}")
            for e in a["encounters"]:
                if e["species"] not in self.species:
                    errs.append(f"area {aid}: unknown species {e['species']}")
            for bx, by in a.get("blocked", []):
                if not (0 <= bx < w and 0 <= by < h):
                    errs.append(f"area {aid}: blocked out of bounds {(bx, by)}")
                elif any(o["x"] == bx and o["y"] == by for o in a["objects"]):
                    errs.append(f"area {aid}: object inside building {(bx, by)}")
            for o in a["objects"]:
                if not (0 <= o["x"] < w and 0 <= o["y"] < h):
                    errs.append(f"area {aid}: object out of bounds {o}")
                if o["kind"] == "exit":
                    to = self.areas.get(o["to"])
                    if not to:
                        errs.append(f"area {aid}: exit to unknown {o['to']}")
                    else:
                        tw, th = len(to["map"][0]), len(to["map"])
                        if not (0 <= o["tx"] < tw and 0 <= o["ty"] < th):
                            errs.append(f"area {aid}: exit target out of bounds {o}")
                        elif to["map"][o["ty"]][o["tx"]] in "#D":
                            errs.append(f"area {aid}: exit target is wall {o}")
                if o["kind"] == "trainer" and o["trainer"] not in self.trainers:
                    errs.append(f"area {aid}: unknown trainer {o['trainer']}")
                if o.get("show_need") is not None:
                    errs += self._validate_need(f"area {aid}: show_need {o.get('label', o['kind'])}", o["show_need"])
                if o["kind"] == "exit":
                    errs += self._validate_need(f"area {aid}: exit to {o.get('to')}", o)
                for key in ("give", "trade", "gift_monster"):
                    if o.get(key):
                        errs += self._validate_need(f"area {aid}: {key} {o.get('label')}", o[key])
                give = o.get("give")
                if give:
                    if give.get("item") not in self.items:
                        errs.append(f"area {aid}: unknown give item {give.get('item')}")
                    for key in ("flag", "text_give"):
                        if not give.get(key):
                            errs.append(f"area {aid}: give missing {key} {o.get('label')}")
                    if any(give.get(k) for k in ("need_medal", "need_dex", "need_flag")) and not give.get("text_before"):
                        errs.append(f"area {aid}: give missing text_before {o.get('label')}")
                    if give.get("need_medal") and give["need_medal"] not in self.medals:
                        errs.append(f"area {aid}: give unknown medal {give['need_medal']}")
                    if not (isinstance(give.get("n", 1), int) and give.get("n", 1) >= 1):
                        errs.append(f"area {aid}: give bad n {o.get('label')}")
                errs += self._validate_special(aid, o)
        for aid in list(self.world_map["cells"]) + self.world_map.get("towns", []):
            if aid not in self.areas or self.areas[aid].get("interior"):
                errs.append(f"world_map: unknown outdoor area {aid}")
        for iid, it in self.items.items():
            if it["kind"] == "scroll" and it.get("move") not in self.moves:
                errs.append(f"item {iid}: unknown scroll move {it.get('move')}")
        evo_items = {s["evolve"].get("item") for s in self.species.values() if s.get("evolve")}
        for iid, it in self.items.items():
            if it["kind"] == "evolution" and iid not in evo_items:
                errs.append(f"item {iid}: evolution item used by no species")
        gate_owner = {}
        for town, md in self.medals.items():
            for k in ("name", "unlock_msg"):
                if not md.get(k):
                    errs.append(f"medal {town}: missing {k}")
            ch = md.get("unlocks")
            if ch:
                if not (isinstance(ch, str) and len(ch) == 1) or ch in "#D.,:":
                    errs.append(f"medal {town}: bad unlocks {ch!r}")
                if not md.get("block_msg"):
                    errs.append(f"medal {town}: missing block_msg")
                if ch in gate_owner:
                    errs.append(f"medal {town}: gate {ch} also opened by {gate_owner[ch]}")
                gate_owner[ch] = town
        for rule in self.config.get("story_flags", ()):
            if not rule.get("flag"):
                errs.append(f"config.story_flags: missing flag {rule}")
            errs += self._validate_need(f"config.story_flags {rule.get('flag')}", rule)
        roam = self.config.get("roamer")
        if roam:
            if roam.get("species") not in self.species:
                errs.append(f"config.roamer: unknown species {roam.get('species')}")
            for k in ("flag", "level", "chance", "areas"):
                if not roam.get(k):
                    errs.append(f"config.roamer: missing {k}")
            for aid in roam.get("areas", []):
                if aid not in self.areas or not self.areas[aid]["encounters"]:
                    errs.append(f"config.roamer: area without encounters {aid}")
            errs += self._validate_need("config.roamer", roam)
        for tid, t in self.trainers.items():
            if t.get("reward_item") and t["reward_item"] not in self.items:
                errs.append(f"trainer {tid}: unknown reward_item {t['reward_item']}")
            for pair in t.get("reward_items", ()):
                if not (isinstance(pair, list) and len(pair) == 2 and pair[0] in self.items
                        and isinstance(pair[1], int) and pair[1] >= 1):
                    errs.append(f"trainer {tid}: bad reward_items {pair!r}")
            if t.get("boss") and t.get("town") not in self.medals:
                errs.append(f"trainer {tid}: boss of unknown town {t.get('town')}")
            parties = [t["party"]] if "party" in t else list(t.get("party_by_starter", {}).values())
            for p in parties:
                for sp, _ in p:
                    if sp not in self.species:
                        errs.append(f"trainer {tid}: unknown species {sp}")
        for sid, path in self.images.items():
            if sid not in self.species:
                errs.append(f"images: unknown species {sid}")
            if not (isinstance(path, str) and path.startswith("img/") and ".." not in path and "\\" not in path):
                errs.append(f"images: bad path {sid} {path!r}（web/img/ 配下の相対パスにする）")
        if self.intro:
            errs += self._validate_intro(self.intro)
        return errs

    INTRO_SHOW = ("prof", "monster", "player", "rival")
    INTRO_ASK = ("player", "rival")

    def _validate_intro(self, d):
        """intro.json の 書き間違いを 起動前に 見つける（名前の 聞き方・置き換え記号の 順番 等）"""
        from .game import Game, ActionError  # 名前の 規則は ゲーム本体と 同じものを 使う
        errs = []

        def ok_name(v):
            try:
                return Game.clean_name(v) == v
            except ActionError:
                return False
        if not (isinstance(d.get("prof_name"), str) and d["prof_name"].strip()):
            errs.append("intro: prof_name が 空")
        if not ok_name(d.get("rival_default")):
            errs.append(f"intro: rival_default {d.get('rival_default')!r} が 名前の 規則（1〜8文字）に 合わない")
        if d.get("monster") not in self.species:
            errs.append(f"intro: monster {d.get('monster')!r} が 図鑑に ない")
        for k in ("player_presets", "rival_presets"):
            v = d.get(k)
            if not (isinstance(v, list) and 1 <= len(v) <= 3 and all(ok_name(n) for n in v)):
                errs.append(f"intro: {k} は 名前（1〜8文字）を 1〜3個")
        script = d.get("script")
        if not (isinstance(script, list) and script):
            return errs + ["intro: script が 空"]
        asked = set()
        for i, st in enumerate(script):
            where = f"intro: script[{i}]"
            if not isinstance(st, dict) or not set(st) <= {"say", "show", "ask"} or not st:
                errs.append(f"{where}: say／show／ask だけを 書く")
                continue
            if "show" in st and st["show"] not in self.INTRO_SHOW:
                errs.append(f"{where}: show は {'/'.join(self.INTRO_SHOW)} のどれか")
            if "ask" in st:
                if st["ask"] not in self.INTRO_ASK or st["ask"] in asked:
                    errs.append(f"{where}: ask は player と rival を 1回ずつ")
                asked.add(st["ask"])
            say = st.get("say", "")
            if not isinstance(say, str):
                errs.append(f"{where}: say は 文字列")
                continue
            for who in self.INTRO_ASK:  # 名前を 聞く前に その名前を 出さない
                if "{" + who + "}" in say and who not in asked - ({st["ask"]} if "ask" in st else set()):
                    errs.append(f"{where}: {{{who}}} を 名前を 聞く 前に 使っている")
        if asked != set(self.INTRO_ASK):
            errs.append("intro: script に ask: player と ask: rival が 両方 必要")
        return errs
