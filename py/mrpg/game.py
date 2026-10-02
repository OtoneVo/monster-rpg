"""ゲーム全体の状態（フィールド・街・メダル・プロンプト・セーブ）。"""
import json
import os
import unicodedata

from .battle import Battle, ActionError
from .data import GameData
from .monster import Monster, friendship_cfg, exp_for_level
from .rng import RngHub

STARTERS = ("pirit", "soyoka", "yurabi")
DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0),
        "n": (0, -1), "s": (0, 1), "w": (-1, 0), "e": (1, 0),
        "north": (0, -1), "south": (0, 1), "west": (-1, 0), "east": (1, 0),
        "北": (0, -1), "南": (0, 1), "西": (-1, 0), "東": (1, 0),
        "上": (0, -1), "下": (0, 1), "左": (-1, 0), "右": (1, 0)}
DIR_NAMES = {(0, -1): "北", (0, 1): "南", (-1, 0): "西", (1, 0): "東"}
ENCOUNTER_TILES = {",", ":"}
WAKEAI_ITEM = "wakeai_suzu"   # わけあいの鈴（たいせつなもの）
WAKEAI_FLAG = "wakeai_on"     # 鈴を 鳴らしている間だけ 立つフラグ
NAME_MAX = 8                  # プレイヤー名の 最大文字数
RIVAL_DEFAULT = "カナタ"       # ライバル名の 既定（intro.json に rival_default が 無い時・旧セーブ）
DEFAULT_SAVE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "saves")


def save_dir():
    return os.environ.get("MONSTER_RPG_SAVE_DIR") or DEFAULT_SAVE_DIR


class Game:
    def __init__(self, mode="normal", seed=None, data=None, logger=None):
        self.data = data or GameData()
        self.rng = RngHub(mode, seed)
        self.logger = logger
        st = self.data.config["start"]
        self.area_id = st["area"]
        self.x, self.y = st["x"], st["y"]
        self.facing = (0, -1)
        self.money = st["money"]
        self.party = []
        self.box = []
        self.items = {}
        self.medals = []
        self.flags = set()
        self.seen = set()
        self.caught = set()
        self.visited = {self.area_id}
        self.defeated = set()
        self.steps = 0
        self.last_heal = [self.area_id, self.x, self.y]
        self.battle = None
        self.prompts = []
        self.area_actions = 0
        self.idle_actions = 0
        self.actions = 0
        self.player_name = ""
        self.rival_name = self.rival_default()
        self.log("new_game", mode=mode, seed=self.rng.base_seed)

    # ---- 共通 ----
    def log(self, event, **kw):
        if self.logger:
            self.logger.event(event, **kw)

    @property
    def area(self):
        return self.data.areas[self.area_id]

    def phase(self):
        t = self.data.config["time"]
        return t["phases"][(self.steps // t["steps_per_phase"]) % len(t["phases"])]

    def place_tags(self):
        """今いる場所の名前（進化条件の place 用）。建物の中なら その街の名前"""
        a = self.area
        if a.get("interior"):
            a = self.data.areas.get(a.get("parent"), a)
        return a.get("place_tags", [])

    def _tablets_all_read(self):
        """今のゲームにある石碑を すべて 読んだか（石碑が増えれば 自動で 増える）"""
        ids = [o["id"] for a in self.data.areas.values() for o in a["objects"] if o["kind"] == "tablet"]
        return bool(ids) and all(f"read_{t}" in self.flags for t in ids)

    def _remix(self, reason, names):
        e = self.rng.remix(reason, names)
        if e:
            self.log("remix", reason=reason, entropy=e["entropy"], states=e["states"])

    def first_alive(self):
        return next((i for i, m in enumerate(self.party) if not m.fainted), None)

    def obey_cap(self):
        if "champion" in self.flags:
            return 100  # 殿堂入り後は どのレベルでも 言うことを聞く
        return self.data.config["medals"]["level_cap"][min(len(self.medals), 8)]

    def capture_cap(self):
        return self.obey_cap()

    def queue_prompt(self, p):
        self.prompts.append(p)

    def note_progress(self, why):
        self.idle_actions = 0
        self.area_actions = 0
        self.log("progress", why=why)

    def set_flag(self, flag):
        if flag not in self.flags:
            self.flags.add(flag)
            self.note_progress(f"flag {flag}")

    def tick_action(self):
        self.actions += 1
        self.area_actions += 1
        self.idle_actions += 1

    def stuck_warning(self):
        cfg = self.data.config["stuck"]
        if self.idle_actions >= cfg["no_progress_actions"]:
            return f"【注意】しばらく進展がありません（{self.idle_actions} 手）。詰まっている可能性があります。方針を見直してみてください。"
        if self.area_actions >= cfg["same_area_actions"]:
            return f"【注意】同じ場所で {self.area_actions} 手が経過しました。詰まっている可能性があります。"
        return None

    def require_free(self):
        if self.battle:
            raise ActionError("戦闘中です。battle_action で行動してください")
        if self.prompts:
            raise ActionError("先に選択肢に答えてください（answer_prompt）")

    # ---- 道具 ----
    def add_item(self, item, n=1):
        self.items[item] = self.items.get(item, 0) + n

    def consume_item(self, item):
        if self.items.get(item, 0) <= 0:
            raise ActionError("その道具を持っていない")
        self.items[item] -= 1
        if self.items[item] == 0:
            del self.items[item]

    def check_item_usable(self, item, mon):
        info = self.data.items[item]
        k = info["kind"]
        if k == "heal":
            if mon.fainted:
                raise ActionError("ひんしのモンスターには 使えない")
            if mon.hp >= mon.maxhp:
                raise ActionError("体力は 満タンだ")
        elif k == "cure":
            if mon.fainted or mon.status is None:
                raise ActionError("使っても 効果がない")
        elif k == "revive":
            if not mon.fainted:
                raise ActionError("ひんしのモンスターにしか 使えない")
        elif k == "scroll":
            if any(m["id"] == info["move"] for m in mon.moves):
                raise ActionError(f"{mon.name}は もう その技を 覚えている")
        elif item == "tabichizu":
            raise ActionError("たびの地図は 見るだけの道具（CLI は map、MCP は get_state の world_map）")
        elif item == WAKEAI_ITEM:
            raise ActionError("わけあいの鈴は 戦闘の外で バッグから 鳴らす／止める")
        elif k == "key":
            raise ActionError(f"{info['name']}は 持っているだけで 役に立つ たいせつなもの")
        elif k == "evolution":
            if not mon.can_evolve(self, item=item):
                ev = mon.sp.get("evolve") or {}
                if ev.get("method") == "held_item" and ev.get("item") == item:
                    raise ActionError(f"{mon.name}には 使うのではなく 持たせて レベルアップさせると よさそうだ（持たせる）")
                raise ActionError("使っても 効果がない")
        elif k == "level_up":
            if mon.fainted:
                raise ActionError("ひんしのモンスターには 使えない")
            if mon.level >= min(100, self.obey_cap()):
                raise ActionError("今は これ以上 レベルを 上げられない（言うことを聞く 上限）")
        else:
            raise ActionError("ここでは 使えない道具だ")

    def apply_item(self, item, mon):
        info = self.data.items[item]
        k = info["kind"]
        if k == "heal":
            mon.hp = min(mon.maxhp, mon.hp + info["heal"])
            return [f"{info['name']}を使った。{mon.name}の 体力が 回復した！"]
        if k == "cure":
            mon.status = None
            mon.toxic_count = 0
            mon.sleep_turns = 0
            return [f"{info['name']}を使った。{mon.name}の 状態異常が 治った！"]
        if k == "revive":
            mon.hp = max(1, mon.maxhp // 2)
            mon.status = None
            return [f"{info['name']}を使った。{mon.name}は 元気を 取り戻した！"]
        return []

    def use_item(self, item, target):
        self.require_free()
        if item not in self.data.items:
            raise ActionError("そんな道具は ない")
        if self.items.get(item, 0) <= 0:
            raise ActionError("その道具を持っていない")
        if item == WAKEAI_ITEM:
            return self._toggle_wakeai()
        if not isinstance(target, int) or not (0 <= target < len(self.party)):
            raise ActionError("対象の番号が正しくない")
        self.check_item_usable(item, self.party[target])
        self.tick_action()
        if self.data.items[item]["kind"] == "scroll":
            return self._use_scroll(item, target)
        if self.data.items[item]["kind"] == "evolution":
            return self._use_evo_item(item, target)
        if self.data.items[item]["kind"] == "level_up":
            return self._use_level_up(item, target)
        self.consume_item(item)
        msgs = self.apply_item(item, self.party[target])
        self.log("use_item", item=item, target=target)
        return msgs

    def give_item(self, item, target):
        """道具を 持たせる（進化の道具だけ）。前に 持たせていた道具は バッグへ 戻す"""
        self.require_free()
        if item not in self.data.items:
            raise ActionError("そんな道具は ない")
        if self.items.get(item, 0) <= 0:
            raise ActionError("その道具を持っていない")
        if self.data.items[item]["kind"] != "evolution":
            raise ActionError("持たせられるのは 進化の道具だけ")
        if not isinstance(target, int) or not (0 <= target < len(self.party)):
            raise ActionError("対象の番号が正しくない")
        mon = self.party[target]
        self.tick_action()
        msgs = []
        if mon.held:
            self.add_item(mon.held)
            msgs.append(f"{mon.name}から {self.data.items[mon.held]['name']}を 返してもらった。")
        self.consume_item(item)
        mon.held = item
        self.log("give_item", item=item, target=target)
        msgs.append(f"{mon.name}に {self.data.items[item]['name']}を 持たせた。")
        return msgs

    def take_item(self, target):
        """持たせた道具を バッグへ 戻す"""
        self.require_free()
        if not isinstance(target, int) or not (0 <= target < len(self.party)):
            raise ActionError("対象の番号が正しくない")
        mon = self.party[target]
        if not mon.held:
            raise ActionError(f"{mon.name}は 何も 持っていない")
        self.tick_action()
        item, mon.held = mon.held, None
        self.add_item(item)
        self.log("take_item", item=item, target=target)
        return [f"{mon.name}から {self.data.items[item]['name']}を 返してもらった。"]

    def _toggle_wakeai(self):
        """わけあいの鈴: 持っている間だけ意味を持つ ON／OFF。フラグで持つのでセーブ形式は変わらない"""
        self.tick_action()
        if WAKEAI_FLAG in self.flags:
            self.flags.discard(WAKEAI_FLAG)
            msg = "わけあいの鈴を 止めた。経験値は 戦闘に 出た 仲間だけが もらう。（OFF）"
        else:
            self.flags.add(WAKEAI_FLAG)
            msg = "わけあいの鈴を 鳴らした。戦闘に 出ていない 仲間も 経験値を すこし もらえる。（ON）"
        self.log("use_item", item=WAKEAI_ITEM, on=WAKEAI_FLAG in self.flags)
        return [msg]

    def wakeai_active(self):
        return WAKEAI_FLAG in self.flags and self.items.get(WAKEAI_ITEM, 0) > 0

    @staticmethod
    def clean_name(name):
        """プレイヤー名を 整えて返す。1〜8文字、前後の空白は落とし、制御文字・書式文字は受け付けない（だめなら ActionError）"""
        if not isinstance(name, str):
            raise ActionError("なまえを 入れてね")
        name = unicodedata.normalize("NFC", name).strip()
        if not name:
            raise ActionError("なまえを 入れてね")
        if len(name) > NAME_MAX:
            raise ActionError(f"なまえは {NAME_MAX}文字まで")
        if any(unicodedata.category(ch).startswith("C") for ch in name):
            raise ActionError("なまえに 使えない 文字が ある")
        return name

    def set_name(self, name):
        """プレイヤー名を決める・変える（Web・静的版・CLI・MCP 共通）"""
        name = self.clean_name(name)
        self.player_name = name
        # 名前そのものは ログに 残さない（長さだけ）
        self.log("set_name", length=len(name))
        return [f"なまえを {name} に した。"]

    def rival_default(self):
        """ライバルの 名前の 既定（data/intro.json の rival_default。無ければ カナタ）"""
        return self.data.intro.get("rival_default") or RIVAL_DEFAULT

    def set_rival(self, name):
        """ライバルの 名前を 決める・変える（Web・静的版・CLI・MCP 共通）"""
        name = self.clean_name(name)
        self.rival_name = name
        self.log("set_rival", length=len(name))  # 名前そのものは 残さない
        return [f"ライバルの なまえを {name} に した。"]

    def trainer_name(self, tid):
        """トレーナーの 表示名（{rival} を 置き換え済み）"""
        return self.fmt(self.data.trainers[tid]["name"])

    def fmt(self, s):
        """データの 文中の {rival} を いまの ライバル名に 置き換える（表示の 直前に 通す）"""
        return s.replace("{rival}", self.rival_name) if isinstance(s, str) else s

    def _use_scroll(self, item, target):
        """巻物: 技が4つ未満なら即覚える。埋まっていれば忘れる技を選ばせ、覚えた時だけ巻物を減らす"""
        info, mon = self.data.items[item], self.party[target]
        mv = info["move"]
        self.log("use_item", item=item, target=target)
        if len(mon.moves) < 4:
            self.consume_item(item)
            mon.learn(mv)
            return [f"{info['name']}を 広げた。{mon.name}は {self.data.moves[mv]['name']}を 覚えた！"]
        self.prompts.append({"kind": "learn_move", "party": target, "move": mv, "scroll": item})
        return [f"{info['name']}を 広げた。{mon.name}は 技を 4つ 覚えている。"]

    def _use_evo_item(self, item, target):
        """進化の道具: 進化の確認を出し、「進化させる」を選んだ時だけ 道具を減らす"""
        mon = self.party[target]
        into = mon.can_evolve(self, item=item)
        self.queue_prompt({"kind": "evolve", "party": target, "into": into, "item": item})
        self.log("use_item", item=item, target=target)
        return [f"{self.data.items[item]['name']}を {mon.name}に 使った。"]

    def _use_level_up(self, item, target):
        """追憶の栞: 次のレベルまでの経験値を足して 1 レベル上げる（技・進化は ふつうのレベルアップと同じ）"""
        mon = self.party[target]
        self.consume_item(item)
        self.log("use_item", item=item, target=target)
        msgs = [f"{self.data.items[item]['name']}を {mon.name}に 読み聞かせた。"]
        need = exp_for_level(mon.sp["growth"], mon.level + 1) - mon.exp
        ups = mon.gain_exp(max(0, need))
        for lv in ups:
            msgs.append(f"{mon.name}は Lv{lv} に 上がった！")
            mon.add_friendship(friendship_cfg(self.data)["level_up"])
            for mv in mon.new_moves_on(lv):
                if mon.learn(mv):
                    msgs.append(f"{mon.name}は {self.data.moves[mv]['name']}を 覚えた！")
                else:
                    self.queue_prompt({"kind": "learn_move", "party": target, "move": mv})
                    msgs.append(f"{mon.name}は {self.data.moves[mv]['name']}を 覚えたがっている")
            self.note_progress(f"{mon.name} Lv{lv}")
        if ups:
            self.queue_evolve(target, mon)
        return msgs

    def queue_evolve(self, i, mon):
        """進化できるなら 進化の確認を 1 件だけ積む（戦闘のレベルアップ・栞 共通）"""
        into = mon.can_evolve(self)
        if into and not any(p["kind"] == "evolve" and p["party"] == i for p in self.prompts):
            self.queue_prompt({"kind": "evolve", "party": i, "into": into})

    def shop_items(self):
        """所持メダル数で 品ぞろえが増える（どの街の店も同じ）。key 品は持っていれば並ばない"""
        n = len(self.medals)
        return [i for need, lst in self.data.shop_tiers if n >= need for i in lst
                if not (self.data.items[i]["kind"] == "key" and self.items.get(i, 0) > 0)]

    def habitats(self, species):
        """図鑑の生息地。見た／捕まえた種だけ。行ったことのない場所は ？？？"""
        if species not in self.seen and species not in self.caught:
            return []
        out = []
        for aid, a in self.data.areas.items():
            if a.get("interior") or not any(e["species"] == species for e in a["encounters"]):
                continue
            name = a["name"] if aid in self.visited else "？？？"
            if name not in out:
                out.append(name)
        return out

    # ---- あずかり箱（休み処に置いてある） ----
    def box_action(self, op, party_index=None, box_index=None):
        """op: deposit(party_index) / withdraw(box_index) / swap(party_index, box_index)。休み処の中でだけ使える"""
        if self.battle:
            raise ActionError("戦闘中は あずかり箱を 使えない")
        if self.prompts and self.prompts[0]["kind"] != "box":
            raise ActionError("先に選択肢に答えてください（answer_prompt）")
        if not any(o["kind"] == "box" for o in self.area["objects"]):
            raise ActionError("あずかり箱は 休み処に ある")

        def pick(lst, i, what):
            if not isinstance(i, int) or not (0 <= i < len(lst)):
                raise ActionError(f"{what}の番号が 正しくない")
            return lst[i]
        if op == "deposit":
            mon = pick(self.party, party_index, "手持ち")
            rest = [m for k, m in enumerate(self.party) if k != party_index]
            if not any(not m.fainted for m in rest):
                raise ActionError("戦えるモンスターが いなくなるので 預けられない")
            self.party.pop(party_index)
            mon.heal_full()
            self.box.append(mon)
            msg = f"{mon.name}を あずかり箱に 預けた。"
        elif op == "withdraw":
            mon = pick(self.box, box_index, "あずかり箱")
            if len(self.party) >= 6:
                raise ActionError("手持ちが いっぱいで 引き出せない（入れ替えなら swap）")
            self.box.pop(box_index)
            self.party.append(mon)
            msg = f"{mon.name}を 手持ちに 加えた。"
        elif op == "swap":
            out = pick(self.party, party_index, "手持ち")
            inn = pick(self.box, box_index, "あずかり箱")
            rest = [m for k, m in enumerate(self.party) if k != party_index] + [inn]
            if not any(not m.fainted for m in rest):
                raise ActionError("戦えるモンスターが いなくなるので 入れ替えられない")
            out.heal_full()
            self.party[party_index], self.box[box_index] = inn, out
            msg = f"{out.name}を 預けて {inn.name}を 手持ちに 加えた。"
        else:
            raise ActionError("op は deposit / withdraw / swap")
        self.tick_action()
        self.log("box", op=op, party_index=party_index, box_index=box_index)
        return [msg]

    def reorder_party(self, order):
        self.require_free()
        if sorted(order) != list(range(len(self.party))):
            raise ActionError(f"並び順は 0〜{len(self.party) - 1} を1回ずつ並べてください")
        self.party = [self.party[i] for i in order]
        self.tick_action()
        return [f"手持ちを 並べ替えた。先頭は {self.party[0].name}"]

    # ---- 地図 ----
    def tile(self, x, y, area=None):
        a = area or self.area
        if 0 <= y < len(a["map"]) and 0 <= x < len(a["map"][0]):
            return a["map"][y][x]
        return "#"

    def object_visible(self, o):
        if o.get("hide_flag") in self.flags:
            return False
        if o.get("show_need") and self._need_unmet(o["show_need"]):
            return False  # 条件（メダル・図鑑の数・フラグ）を満たすまで 出てこない
        if o["kind"] != "exit" and o.get("require_flag") and o["require_flag"] not in self.flags:
            return False  # 条件を満たすまで 出てこない（固定シンボル 等）。出口の require_flag は 通れるかどうか
        if o["kind"] in ("static", "item") and o.get("flag") in self.flags:
            return False  # 捕まえた固定シンボル・拾った道具
        if o["kind"] == "trainer":
            t = self.data.trainers[o["trainer"]]
            if len(self.medals) < o.get("show_if_medals", 0):
                return False
            if t.get("flag") and o["trainer"] in self.defeated:
                return False  # 霧の会の会員は倒すと去る
        return True

    def object_at(self, x, y):
        for o in self.area["objects"]:
            if o["x"] == x and o["y"] == y and self.object_visible(o):
                return o
        return None

    def unlocked(self, ch):
        for town in self.medals:
            if self.data.medals[town].get("unlocks") == ch:
                return True
        return False

    def passable(self, ch):
        if ch in ("#", "D"):
            return False
        if ch in self.data.gates:  # メダルで 通れるようになる 関門（trainers.json の medals の unlocks）
            return self.unlocked(ch)
        return True

    def exit_open(self, o):
        """出口を 通れるか（require_flag と need_medal／need_medals／need_dex／need_flag／need_flags）"""
        if o.get("require_flag") and o["require_flag"] not in self.flags:
            return False
        return not self._need_unmet(o)

    # ---- 移動 ----
    def move(self, direction, steps=1):
        self.require_free()
        d = DIRS.get(str(direction).lower()) or DIRS.get(str(direction))
        if d is None:
            raise ActionError("方向は up/down/left/right（北/南/西/東）で指定してください")
        if not isinstance(steps, int) or steps < 1:
            steps = 1
        steps = min(steps, 20)
        self.tick_action()
        self.facing = d
        msgs = []
        moved = 0
        for _ in range(steps):
            nx, ny = self.x + d[0], self.y + d[1]
            obj = self.object_at(nx, ny)
            if obj and obj["kind"] != "exit":
                msgs.extend(self._bump(obj))
                break
            # 建物は 壁ごと通れない。入口も 正面（下から北向き）からしか入れない
            if [nx, ny] in self.area.get("blocked", ()) or (obj and obj.get("building") and d != (0, -1)):
                msgs.append("その先へは 進めない。")
                break
            ch = self.tile(nx, ny)
            if not self.passable(ch):
                msgs.append(self._block_msg(ch))
                break
            if obj and obj["kind"] == "exit" and not self.exit_open(obj):
                msgs.append(obj.get("block_msg", "今は 先へ進めない"))
                break
            self.x, self.y = nx, ny
            self.steps += 1
            moved += 1
            if obj and obj["kind"] == "exit":
                msgs.extend(self._enter_area(obj["to"], obj["tx"], obj["ty"]))
                break
            if ch in ENCOUNTER_TILES and self.first_alive() is not None and \
                    self.rng["encounter"].chance65536(self.data.config["encounter_rate"]):
                msgs.extend(self._start_wild())
                break
        msgs.insert(0, f"{DIR_NAMES[d]}へ {moved} 歩 進んだ。") if moved else None
        self.log("move", direction=DIR_NAMES[d], steps=steps, moved=moved, area=self.area_id, x=self.x, y=self.y)
        return msgs

    def _block_msg(self, ch):
        town = self.data.gates.get(ch)
        if town:
            return self.data.medals[town].get("block_msg", "その先へは 進めない。")
        return "その先へは 進めない。"

    def _with_town(self, area_id):
        """その場所と、建物ならその町（行ったことのある場所に入れる単位）"""
        a = self.data.areas.get(area_id)
        return {area_id, a.get("parent") or area_id} if a else set()

    def _free_spot(self, x, y, area_id=None):
        """(x, y) が立てるマスでなければ（建物の壁・入口・物の上、通れない地形、地図の外）、いちばん近い立てるマスを返す。
        立てても 入口まで歩いて行けない閉じたマス（研究所の博士の奥など）なら、入口まで歩けるいちばん近いマスへ移す。
        area_id を渡すと、今いる場所ではなくその場所で探す（最後に休んだ場所の補正用）"""
        a = self.data.areas[area_id or self.area_id]
        blocked = a.get("blocked", ())
        if not (isinstance(x, int) and isinstance(y, int)):
            return x, y  # 座標が整数でない位置は ここでは直さない（前の版と同じ）
        w, h = len(a["map"][0]), len(a["map"])
        objs = {}  # 見えている物（同じマスに2つあれば object_at と同じく先の物）
        for o in a["objects"]:
            if self.object_visible(o):
                objs.setdefault((o["x"], o["y"]), o)

        def standable(px, py):
            return [px, py] not in blocked and self.passable(self.tile(px, py, a)) and (px, py) not in objs

        def near(px, py):
            for dx, dy in ((0, 1), (-1, 0), (1, 0), (0, -1)):
                if 0 <= px + dx < w and 0 <= py + dy < h:
                    yield px + dx, py + dy, (dx, dy)

        def enter_ok(px, py, d):  # move() と同じ条件で、向き d に歩いて (px, py) の入口へ入れるか
            o = objs.get((px, py))
            return bool(o and o["kind"] == "exit" and [px, py] not in blocked
                        and not (o.get("building") and d != (0, -1)) and self.passable(self.tile(px, py, a))
                        and self.exit_open(o))

        # 入口まで歩いて行ける立てるマス（入口の隣から、立てるマスづたいに広げる）
        stand = {(px, py) for py in range(h) for px in range(w) if standable(px, py)}
        walk = [p for p in stand if any(enter_ok(nx, ny, d) for nx, ny, d in near(*p))]
        good = set(walk)
        for px, py in walk:
            for nx, ny, _ in near(px, py):
                if (nx, ny) in stand and (nx, ny) not in good:
                    good.add((nx, ny))
                    walk.append((nx, ny))
        good = good or stand  # 入口まで行けるマスが1つも無い場所なら、立てるマスならどこでもよい（前の版と同じ）
        # 地図の外を指していたら（手で直したセーブ等）、いちばん近い地図の中のマスから探す
        x, y = min(max(x, 0), w - 1), min(max(y, 0), h - 1)
        seen, queue = {(x, y)}, [(x, y)]
        for px, py in queue:
            if (px, py) in good:
                return px, py
            for nx, ny, _ in near(px, py):
                if (nx, ny) not in seen:
                    seen.add((nx, ny))
                    queue.append((nx, ny))
        return x, y

    def _enter_area(self, area_id, x, y):
        was_inside = self.area.get("interior")
        self.area_id = area_id
        self.x, self.y = x, y
        self.area_actions = 0
        self._remix(f"area:{area_id}", ["encounter", "pickup", "misc"])
        msgs = [f"{self.area['name']}に 入った。" if self.area.get("interior")
                else "外に 出た。" if was_inside else f"{self.area['name']}に 着いた。"]
        if self.area.get("weather") == "fog":
            msgs.append("あたりには 濃い霧が 立ちこめている。")
        if area_id not in self.visited:
            self.visited.add(area_id)
            self.note_progress(f"new area {area_id}")
        gift = self.area.get("arrive_gift")  # 着いた時にもらえる救済の巻物（1回だけ）
        if gift and gift["flag"] not in self.flags:
            self.set_flag(gift["flag"])
            self.add_item(gift["item"])
            msgs.extend(gift["text"])
            msgs.append(f"{self.data.items[gift['item']]['name']}を もらった！（バッグから使うと技を覚えられる）")
        self.log("enter_area", area=area_id)
        return msgs

    def _bump(self, o):
        k = o["kind"]
        label = self.fmt(o.get("label", ""))
        if k == "trainer":
            tid = o["trainer"]
            if tid in self.defeated:
                return [f"{label}『もう勝負は ついたよ』"]
            return self._start_trainer(tid)
        return [f"目の前に {label}がある。interact で 話す／調べる ことができる。"]

    def facing_object(self):
        fx, fy = self.x + self.facing[0], self.y + self.facing[1]
        o = self.object_at(fx, fy)
        if not o and self.area.get("interior") and self.tile(fx, fy) == "D":
            o = self.object_at(fx + self.facing[0], fy + self.facing[1])  # カウンター越しに話す
        return o

    def interact(self):
        self.require_free()
        self.tick_action()
        o = self.facing_object()
        if not o or o["kind"] == "exit":
            return ["目の前には 何もない。（向いている方向のマスを調べます）"]
        k = o["kind"]
        self.log("interact", kind=k, label=o.get("label"))  # {rival} は 置き換える前の まま（名前を ログに 残さない）
        # 表示用に {rival} を 置き換えた 写しで 進める（データ本体は 書き換えない）
        o = {**o, **{f: self.fmt(o[f]) for f in ("label", "text") if f in o}}
        if k == "trainer":
            return self._bump(o)
        if k == "npc":
            if o.get("trade"):
                return self._npc_trade(o)
            if o.get("gift_monster"):
                return self._gift_monster(o)
            if o.get("give"):
                return self._npc_give(o)
            if o.get("sign"):
                return [f"{o['label']}に 書いてある。『{o['text']}』"]
            return [f"{o['label']}『{o['text']}』"]
        if k == "tablet":
            msgs = [f"{o['label']}を 調べた。", o["text"]]
            self.set_flag(f"read_{o['id']}")
            if "all_tablets_read" not in self.flags and self._tablets_all_read():
                self.set_flag("all_tablets_read")
                msgs.append("……どこかで 澄んだ 響きが した気がする。")
            msgs.extend(self._check_story())
            return msgs
        if k == "heal":
            for m in self.party:
                m.heal_full()
            self.last_heal = [self.area_id, self.x, self.y]
            return [f"{o['label']}『いらっしゃい。ゆっくり 休んでいきな』",
                    "手持ちのモンスターは すっかり元気になった！"]
        if k == "box":
            self.queue_prompt({"kind": "box"})
            return [f"{o['label']}を 開いた。（預けた仲間は 元気になる。box_action で 預ける／引き出す／入れ替え）"]
        if k == "shop":
            self.queue_prompt({"kind": "shop", "shop": o["shop"]})
            return [f"{o['label']}『いらっしゃい！ 何にします？』（answer_prompt で番号と個数を指定）"]
        if k == "lab":
            if "got_starter" in self.flags:
                if o.get("gift_monster"):
                    return self._gift_monster(o, lab=True)
                return ["博士『旅は順調かね？ 出会ったモンスターは記録しておくんだよ』"]
            self.queue_prompt({"kind": "starter"})
            return ["博士『おお、来たね。わしは この村で モンスターの 記録を つけている者だ』",
                    "博士『村の外の 草むらには 野生のモンスターが いる。ひとりで 出るのは 危ない』",
                    "博士『そこで この村に 伝わる 三匹から、相棒を 一匹 選びなさい』（answer_prompt で番号を指定）"]
        if k == "gym":
            town = o["town"]
            if town in self.medals:
                return [f"{o['label']}の主『もう{self.data.medals[town]['name']}は渡したよ。腕を磨いておいで』"]
            if self.first_alive() is None:
                return ["戦えるモンスターが いない。"]
            tid = next(t for t, v in self.data.trainers.items() if v.get("boss") and v["town"] == town)
            return self._start_trainer(tid)
        if k == "item":
            self.set_flag(o["flag"])
            self.add_item(o["item"])
            name = self.data.items[o["item"]]["name"]
            self.log("field_item", item=o["item"], flag=o["flag"])
            return [f"{o.get('label', '光るもの')}を 調べた。", f"{name}を 手に入れた！"]
        if k == "static":
            return self._start_static(o)
        return []

    def _need_unmet(self, cond):
        """条件（メダル・図鑑の数・フラグ・フラグの一覧・メダルの数）が まだなら True。NPC・出口・出てくる物で使う"""
        if cond.get("need_medal") and cond["need_medal"] not in self.medals:
            return True
        if len(self.caught) < cond.get("need_dex", 0):
            return True
        if cond.get("need_flag") and cond["need_flag"] not in self.flags:
            return True
        if any(f not in self.flags for f in cond.get("need_flags", ())):
            return True
        return len(self.medals) < cond.get("need_medals", 0)

    def _npc_give(self, o):
        """道具を 1 回だけ渡す NPC。渡した後と、条件（メダル・図鑑の数・フラグ）が まだの時は 台詞だけ"""
        give = o["give"]
        if give["flag"] in self.flags:
            return [f"{o['label']}『{o['text']}』"]
        if self._need_unmet(give):
            return [f"{o['label']}『{give['text_before']}』"]
        self.set_flag(give["flag"])
        info = self.data.items[give["item"]]
        self.log("npc_give", item=give["item"], label=o.get("label"))
        if info["kind"] == "key":
            if self.items.get(give["item"], 0) <= 0:
                self.add_item(give["item"])
            got = (f"{info['name']}を 手に入れた！（バッグの たいせつなもの から 選ぶと ON／OFF を 切り替えられる）"
                   if give["item"] == WAKEAI_ITEM else f"{info['name']}を 手に入れた！（たいせつなもの）")
            return [f"{o['label']}『{give['text_give']}』", got]
        n = give.get("n", 1)
        self.add_item(give["item"], n)
        got = f"{info['name']}を {n} 個 手に入れた！" if n > 1 else f"{info['name']}を 手に入れた！"
        return [f"{o['label']}『{give['text_give']}』", got]

    def _npc_trade(self, o):
        """NPC との交換（1 回だけ）。渡す種族を連れていれば 誰を渡すか 選ばせる"""
        tr = o["trade"]
        label = o["label"]
        if f"{tr['id']}_done" in self.flags or self._need_unmet(tr):
            return [f"{label}『{o['text']}』"]
        if any(m.species == tr["give"] for m in self.party):
            self.queue_prompt({"kind": "trade", "trade": dict(tr), "label": label})
            return [f"{label}『{tr['text_ask']}』"]
        return [f"{label}『{o['text']}』", f"{label}『{tr['text_offer']}』"]

    def _gift_monster(self, o, lab=False):
        """御三家の 残りを 1 体 もらう（条件: 図鑑の数・メダルの数）。もらった後・残りが無い時は 台詞だけ"""
        gm = o["gift_monster"]
        label = "博士" if lab else o["label"]
        normal = ["博士『旅は順調かね？ 出会ったモンスターは記録しておくんだよ』"] if lab else [f"{label}『{o['text']}』"]
        remaining = [s for s in STARTERS if f"starter_{s}" not in self.flags and f"gift_starter_{s}" not in self.flags]
        if f"gift_{gm['id']}_done" in self.flags or not remaining:
            return normal
        if self._need_unmet(gm):
            return normal + [f"{label}『{gm['text_before']}』"] if gm.get("text_before") else normal
        self.queue_prompt({"kind": "gift_choose", "id": gm["id"], "level": gm["level"],
                           "options": remaining, "label": label})
        return [f"{label}『{gm['text_give']}』"]

    def _receive(self, mon):
        """もらった・交換したモンスターを 手持ち（いっぱいなら 預かり箱）へ"""
        self.seen.add(mon.species)
        self.caught.add(mon.species)
        if len(self.party) < 6:
            self.party.append(mon)
            return f"{mon.name}を 受け取った！"
        mon.heal_full()  # 箱に入った子は 全回復
        self.box.append(mon)
        return f"{mon.name}を 受け取った！ 手持ちが いっぱいなので 預かり箱へ 送った。"

    def _start_static(self, o):
        """固定シンボル（その場から動かないモンスター）との戦闘。捕まえるまで 何度でも 挑める"""
        if self.first_alive() is None:
            return ["戦えるモンスターが いない。"]
        self._remix("battle_start", ["battle", "capture"])
        mon = self._make_enemy(o["species"], o["level"])
        if o.get("met_flag"):
            self.set_flag(o["met_flag"])  # 出会った記録（始まりの鍵の条件）。捕まえなくても 立つ
        self.battle = Battle(self, "wild", [mon], legend=bool(mon.sp.get("legend")),
                             weather=self.area.get("weather"), static_flag=o["flag"])
        self.seen.add(mon.species)
        self.log("battle_start", kind="static", species=mon.species, level=mon.level,
                 seeds=self.rng.to_dict()["states"])
        msgs = [o["text"]] if o.get("text") else []
        msgs.append(f"{mon.name}（Lv{mon.level}）が 現れた！")
        if mon.shiny:
            msgs.append("……なんだか 色が 違う気がする！")
        msgs.append(f"行け、{self.battle.player.name}！")
        return msgs

    def _check_story(self):
        """条件がそろったら 立つ 話のフラグ（config.story_flags。霧が晴れる 等）。立った時の 文を返す"""
        msgs = []
        for rule in self.data.config.get("story_flags", ()):
            if rule["flag"] not in self.flags and not self._need_unmet(rule):
                self.set_flag(rule["flag"])
                self.log("story", flag=rule["flag"])
                msgs.extend(rule.get("text", []))
        return msgs

    # ---- 戦闘開始 ----
    def _make_enemy(self, sp, level):
        shiny = self.rng["misc"].chance65536(self.data.config["shiny_in_65536"])
        return Monster(self.data, sp, max(1, min(100, level)), rng=self.rng["misc"], shiny=shiny)

    def _start_wild(self):
        encs = [e for e in self.area["encounters"] if not e.get("time") or self.phase() in e["time"]]
        if not encs:
            return []
        r = self.rng["encounter"]
        roam = self.data.config.get("roamer")
        if roam and roam["flag"] not in self.flags and self.area_id in roam["areas"] \
                and not self._need_unmet(roam) and r.chance65536(roam["chance"]):
            return self._start_roamer(roam)
        e = r.weighted([(e, e["weight"]) for e in encs])
        mc = self.data.config["medals"]
        n = len(self.medals)
        lo = e["min"] + n * mc["field_floor_step"]
        if mc.get("field_floor_cap_margin") is not None:  # 床の上げ幅は 言うことを聞く上限の 少し下で 止める
            lo = max(e["min"], min(lo, mc["level_cap"][min(n, 8)] - mc["field_floor_cap_margin"]))
        level = r.range(lo, max(e["max"], lo))
        self._remix("battle_start", ["battle", "capture"])
        mon = self._make_enemy(e["species"], level)
        legend = bool(mon.sp.get("legend"))
        self.battle = Battle(self, "wild", [mon], legend=legend, weather=self.area.get("weather"))
        self.seen.add(mon.species)
        self.log("battle_start", kind="wild", species=mon.species, level=level, seeds=self.rng.to_dict()["states"])
        msgs = [f"あっ！ 野生の {mon.name}（Lv{level}）が 飛び出してきた！"]
        if mon.shiny:
            msgs.append("……なんだか 色が 違う気がする！")
        msgs.append(f"行け、{self.battle.player.name}！")
        return msgs

    def _start_roamer(self, roam):
        """あちこちの道に 駆け込んでくる モンスター（config.roamer）。捕まえるまで 出続ける"""
        self._remix("battle_start", ["battle", "capture"])
        mon = self._make_enemy(roam["species"], roam["level"])
        self.battle = Battle(self, "wild", [mon], legend=bool(mon.sp.get("legend")),
                             weather=self.area.get("weather"), static_flag=roam["flag"])
        self.seen.add(mon.species)
        self.log("battle_start", kind="roamer", species=mon.species, level=mon.level,
                 seeds=self.rng.to_dict()["states"])
        msgs = list(roam.get("text", [])) + [f"あっ！ {mon.name}（Lv{mon.level}）が 駆け込んできた！"]
        if mon.shiny:
            msgs.append("……なんだか 色が 違う気がする！")
        msgs.append(f"行け、{self.battle.player.name}！")
        return msgs

    def _devolve(self, sp, level):
        """道場主の手持ちは、そのレベルでまだ進化できない形なら進化前に戻す（順番で戦う相手のレベルが変わるため）"""
        parent = {s["evolve"]["into"]: (k, s["evolve"].get("level"))
                  for k, s in self.data.species.items() if s.get("evolve")}
        while sp in parent and parent[sp][1] and level < parent[sp][1]:
            sp = parent[sp][0]
        return sp

    def _start_trainer(self, tid):
        t = self.data.trainers[tid]
        if self.first_alive() is None:
            return ["戦えるモンスターが いない。"]
        if t.get("boss"):
            base = self.data.config["medals"]["order_boss_level"][min(len(self.medals), 7)]
            party = [(self._devolve(sp, base + off), base + off) for sp, off in t["party"]]
        elif "party_by_starter" in t:
            party = t["party_by_starter"][self.starter]
        else:
            party = t["party"]
        self._remix("battle_start", ["battle", "capture"])
        enemies = [self._make_enemy(sp, lv) for sp, lv in party]
        if "moves_upto_level" in t:  # 最初のライバル戦は属性技なしで戦わせる
            cap = t["moves_upto_level"]
            for m in enemies:
                keep = {mid for lv, mid in m.sp["learnset"] if lv <= cap}
                m.moves = [mv for mv in m.moves if mv["id"] in keep] or m.moves[:1]
        for m in enemies:
            self.seen.add(m.species)
        kind = "boss" if t.get("boss") else "trainer"
        self.battle = Battle(self, kind, enemies, trainer_id=tid, weather=self.area.get("weather"))
        self.log("battle_start", kind=kind, trainer=tid, party=[[m.species, m.level] for m in enemies],
                 seeds=self.rng.to_dict()["states"])
        name = self.trainer_name(tid)
        return [self.fmt(t["intro"]), f"{name}が 勝負を しかけてきた！",
                f"{name}は {enemies[0].name}（Lv{enemies[0].level}）を 繰り出した！",
                f"行け、{self.battle.player.name}！"]

    @property
    def starter(self):
        for s in STARTERS:
            if f"starter_{s}" in self.flags:
                return s
        return STARTERS[0]

    # ---- 戦闘行動 ----
    def battle_action(self, action):
        if not self.battle:
            raise ActionError("戦闘中ではない")
        b = self.battle
        self.last_frames = None
        self.tick_action()
        msgs = b.act(action)
        # 画面用: メッセージ1件ごとの HP・状態（戦闘後の処理ぶんは無し）
        self.last_frames = list(b.frames) + [None] * (len(msgs) - len(b.frames))
        self.log("battle_action", action=action, turn=b.turn - 1, messages=msgs)
        if b.state == "over":
            end = self._end_battle()
            msgs.extend(end)
            self.last_frames += [None] * len(end)
        return msgs

    def _end_battle(self):
        b = self.battle
        self.battle = None
        msgs = []
        res = b.result
        self.log("battle_end", result=res, kind=b.kind, trainer=b.trainer_id,
                 enemies=[[m.species, m.level] for m in b.enemies])
        if res == "win":
            if b.kind != "wild":
                self.money += b.money
                self.defeated.add(b.trainer_id)
                t = self.data.trainers[b.trainer_id]
                if t.get("flag"):
                    self.set_flag(t["flag"])
                for item, n in t.get("reward_items", ()):
                    self.add_item(item, n)
                    name = self.data.items[item]["name"]
                    msgs.append(f"{name}を {n} 個 もらった！" if n > 1 else f"{name}を もらった！")
                if t.get("ending"):
                    self.log("champion", trainer=b.trainer_id, actions=self.actions)
                    msgs.extend(t["ending"])
                if b.trainer_id == "rival_1":
                    self.set_flag("rival_1_done")
                if t.get("boss"):
                    town = t["town"]
                    self.medals.append(town)
                    md = self.data.medals[town]
                    msgs.append(f"{md['name']}を 手に入れた！（{md['unlock_msg']}）")
                    self.note_progress(f"medal {town}")
                    if t.get("reward_item"):
                        self.add_item(t["reward_item"])
                        msgs.append(f"{self.data.items[t['reward_item']]['name']}も もらった！ バッグから 仲間に 使える。")
                    msgs.append(f"これで メダルは {len(self.medals)} 個。言うことを聞くレベルの上限が 上がった。")
                    if any(need == len(self.medals) for need, _ in self.data.shop_tiers):
                        msgs.append("お店の 品ぞろえが 増えた！")
                msgs.extend(self._check_story())
            else:
                msgs.extend(self._pickup())
            if self.first_alive() is None:  # 相打ちで勝った時は、お金は減らさず最後に休んだ場所へ戻す
                area, x, y = self.last_heal
                self.area_id = area
                self.x, self.y = self._free_spot(x, y)  # 戻り先が建物の壁や入口の上になっていても 立てるマスへ
                self.visited |= self._with_town(area)
                self.area_actions = 0
                for m in self.party:
                    m.heal_full()
                msgs.append(f"手持ちが 全員 倒れたので、最後に休んだ場所へ 戻った。（{self.area['name']}）")
        elif res == "capture":
            mon = b.captured
            cap = self.capture_cap()
            if mon.level > cap:
                mon.set_level(cap)
                mon.reset_moves(cap)
                msgs.append(f"{mon.name}は 結ばれた反動で Lv{cap} まで 力が落ちた。")
            mon.status = None
            self.caught.add(mon.species)
            if getattr(b, "static_flag", None):
                self.set_flag(b.static_flag)
            if len(self.party) < 6:
                self.party.append(mon)
                msgs.append(f"{mon.name}が 仲間に 加わった！")
            else:
                mon.heal_full()  # 箱に入った子は 入り方によらず 全回復（預ける・入れ替えと同じ）
                self.box.append(mon)
                msgs.append(f"手持ちが いっぱいなので {mon.name}は 預かり箱へ 送られた。")
            self.note_progress(f"capture {mon.species}")
        elif res == "lose":
            if b.trainer_id == "rival_1":
                for m in self.party:
                    m.heal_full()
                self.set_flag("rival_1_done")
                msgs.append(f"{self.rival_name}『へへっ、まだまだだな！ 博士に回復してもらえよ』（手持ちは回復した）")
            else:
                lost = int(self.money * self.data.config["whiteout_money_ratio"])
                self.money -= lost
                area, x, y = self.last_heal
                self.area_id = area
                self.x, self.y = self._free_spot(x, y)  # 戻り先が建物の壁や入口の上になっていても 立てるマスへ
                self.visited |= self._with_town(area)
                self.area_actions = 0
                for m in self.party:
                    m.heal_full()
                msgs.append(f"{lost} 円を 落としてしまった……。最後に休んだ場所へ 戻った。（{self.area['name']}）")
        if self.prompts:
            msgs.append("（選択待ちがあります。answer_prompt で答えてください）")
        return msgs

    def _pickup(self):
        r = self.rng["pickup"]
        pk = self.data.pickup
        if not r.chance65536(pk["chance"]):
            return []
        item = r.weighted([(i, w) for i, w in pk["table"]])
        self.add_item(item)
        alive = [m for m in self.party if not m.fainted]
        who = alive[r.below(len(alive))].name if alive else "手持ち"
        self.log("pickup", item=item)
        return [f"{who}が 何かを拾ってきた！ {self.data.items[item]['name']}を 手に入れた！"]

    # ---- 選択肢 ----
    def prompt_view(self):
        """先頭の選択肢を {text, options} で返す"""
        if not self.prompts:
            return None
        p = self.prompts[0]
        k = p["kind"]
        if k == "starter":
            opts = [f"{self.data.species[s]['name']}（{'・'.join(self.data.species[s]['types'])}タイプ）" for s in STARTERS]
            return {"kind": k, "text": "相棒にするモンスターを選んでください", "options": opts}
        if k == "shop":
            opts = [f"{self.data.items[i]['name']}  {self.data.items[i]['price']}円  - {self.data.items[i]['desc']}"
                    for i in self.shop_items()]
            opts.append("やめる")
            return {"kind": k, "text": f"所持金 {self.money}円。買う物の番号と個数（count）を指定", "options": opts}
        if k == "learn_move":
            mon = self.party[p["party"]]
            mv = self.data.moves[p["move"]]
            opts = [f"{self.data.moves[m['id']]['name']} を忘れる" for m in mon.moves]
            opts.append(f"{mv['name']}を 覚えない")
            return {"kind": k, "text": f"{mon.name}は {mv['name']}（{mv['type']}）を覚えたい。どの技を忘れさせる？",
                    "options": opts}
        if k == "evolve":
            mon = self.party[p["party"]]
            return {"kind": k, "text": f"おや……？ {mon.name}の 様子が……！", "options": ["進化させる", "進化をやめさせる"],
                    "into": p.get("into") or mon.sp["evolve"]["into"]}
        if k == "trade":
            tr = p["trade"]
            opts = [f"{m.name} Lv{m.level} を 渡す" for m in self.party if m.species == tr["give"]]
            opts.append("やめる")
            get = self.data.species[tr["get"]]["name"]
            return {"kind": k, "text": f"{p['label']}と 交換する？（{get}を もらえる）", "options": opts}
        if k == "gift_choose":
            opts = [f"{self.data.species[s]['name']}（{'・'.join(self.data.species[s]['types'])}タイプ）" for s in p["options"]]
            opts.append("やめる")
            return {"kind": k, "text": "どのモンスターを もらう？", "options": opts}
        if k == "box":
            inbox = "、".join(f"{i}:{m.name} Lv{m.level}" for i, m in enumerate(self.box)) or "（空っぽ）"
            return {"kind": k, "text": f"あずかり箱 {len(self.box)} 匹: {inbox}。box_action で操作、終わったら 0 で閉じる",
                    "options": ["閉じる"]}
        return {"kind": k, "text": "", "options": []}

    def answer_prompt(self, index, count=1):
        if self.battle:
            raise ActionError("戦闘中は 選択肢に答えられない")
        if not self.prompts:
            raise ActionError("答える選択肢は ない")
        view = self.prompt_view()
        if not isinstance(index, int) or not (0 <= index < len(view["options"])):
            raise ActionError(f"番号は 0〜{len(view['options']) - 1} で指定してください")
        p = self.prompts[0]
        k = p["kind"]
        self.tick_action()
        msgs = []
        if k == "starter":
            self.prompts.pop(0)
            sp = STARTERS[index]
            mon = Monster(self.data, sp, 5, rng=self.rng["misc"])
            self.party.append(mon)
            self.caught.add(sp)
            self.seen.add(sp)
            self.set_flag("got_starter")
            self.set_flag(f"starter_{sp}")
            for it, n in self.data.config["starter_items"].items():
                self.add_item(it, n)
            items = "、".join(f"{self.data.items[i]['name']}×{n}" for i, n in self.data.config["starter_items"].items())
            msgs.append(f"{mon.name}を 相棒に選んだ！ 博士から {items}を もらった。")
            msgs.extend(self._start_trainer("rival_1"))
        elif k == "shop":
            lst = self.shop_items()
            if index == len(lst):
                self.prompts.pop(0)
                return ["『またどうぞ！』"]
            item = lst[index]
            info = self.data.items[item]
            if not isinstance(count, int) or count < 1:
                count = 1
            if info["kind"] == "key":
                count = 1
            cost = info["price"] * count
            if cost > self.money:
                return [f"お金が 足りない。（{cost}円 必要、所持 {self.money}円）"]
            self.money -= cost
            self.add_item(item, count)
            msgs.append(f"{info['name']}を {count} 個 買った。（残り {self.money}円）続けて買えます。")
            bonus = self.data.shop_bonus
            if bonus and info["kind"] == bonus["kind"] and count >= bonus["per"]:
                n = count // bonus["per"]
                self.add_item(bonus["gift"], n)
                msgs.append(f"おまけに {self.data.items[bonus['gift']]['name']}を {n} 個 もらった！")
        elif k == "learn_move":
            self.prompts.pop(0)
            mon = self.party[p["party"]]
            mv = self.data.moves[p["move"]]
            if index == len(mon.moves):
                msgs.append(f"{mon.name}は {mv['name']}を 覚えずに 終わった。")
            else:
                old = self.data.moves[mon.moves[index]["id"]]["name"]
                if p.get("scroll"):
                    self.consume_item(p["scroll"])
                mon.learn(p["move"], index)
                msgs.append(f"1、2の……ポカン！ {mon.name}は {old}を 忘れて {mv['name']}を 覚えた！")
        elif k == "evolve" and index == 0 and p.get("item") and self.items.get(p["item"], 0) <= 0:
            self.prompts.pop(0)
            msgs.append("道具が 無いので 進化しなかった。")
        elif k == "evolve":
            self.prompts.pop(0)
            mon = self.party[p["party"]]
            if index == 0:
                old = mon.name
                if p.get("item"):
                    self.consume_item(p["item"])
                mon.evolve(p.get("into"))
                self.seen.add(mon.species)
                self.caught.add(mon.species)
                msgs.append(f"おめでとう！ {old}は {mon.name}に 進化した！")
                for mvid in mon.new_moves_on(mon.level):
                    if mon.learn(mvid):
                        msgs.append(f"{mon.name}は {self.data.moves[mvid]['name']}を 覚えた！")
                self.note_progress(f"evolve {mon.species}")
            else:
                msgs.append(f"{mon.name}は 進化を やめた。")
        elif k == "box":
            self.prompts.pop(0)
            msgs.append("あずかり箱を 閉じた。")
        elif k == "trade":
            self.prompts.pop(0)
            tr = p["trade"]
            slots = [i for i, m in enumerate(self.party) if m.species == tr["give"]]
            if index == len(slots):
                msgs.append("交換を やめた。")
            else:
                old = self.party[slots[index]]
                level = min(tr["level"], self.capture_cap())
                mon = Monster(self.data, tr["get"], level, rng=self.rng["misc"])
                self.party[slots[index]] = mon
                self.seen.add(mon.species)
                self.caught.add(mon.species)
                self.set_flag(f"{tr['id']}_done")
                self.note_progress(f"trade {tr['id']}")
                if old.held:  # 持たせていた道具は 渡す前に 返してもらう
                    msgs.append(f"{old.name}に 持たせていた {self.data.items[old.held]['name']}を バッグに 戻した。")
                    self.add_item(old.held)
                    old.held = None
                msgs += [f"{old.name}を {p['label']}に 渡した。", f"{p['label']}『{tr['text_done']}』",
                         f"{mon.name}を 受け取った！"]
        elif k == "gift_choose":
            self.prompts.pop(0)
            if index == len(p["options"]):
                msgs.append("また 今度に した。")
            else:
                sp = p["options"][index]
                level = min(p["level"], self.capture_cap())
                mon = Monster(self.data, sp, level, rng=self.rng["misc"])
                self.set_flag(f"gift_{p['id']}_done")
                self.set_flag(f"gift_starter_{sp}")  # starter_* は 最初の相棒だけ（ライバルの手持ちが変わらないように）
                msgs.append(self._receive(mon))
                self.note_progress(f"gift {sp}")
        self.log("answer_prompt", kind=k, index=index, count=count)
        return msgs

    # ---- セーブ ----
    def to_dict(self):
        return {"version": 1, "area_id": self.area_id, "x": self.x, "y": self.y, "facing": list(self.facing),
                "money": self.money, "party": [m.to_dict() for m in self.party],
                "box": [m.to_dict() for m in self.box], "items": self.items, "medals": self.medals,
                "flags": sorted(self.flags), "seen": sorted(self.seen), "caught": sorted(self.caught),
                "visited": sorted(self.visited), "defeated": sorted(self.defeated), "steps": self.steps,
                "last_heal": self.last_heal, "battle": self.battle.to_dict() if self.battle else None,
                "prompts": self.prompts, "area_actions": self.area_actions, "idle_actions": self.idle_actions,
                "actions": self.actions, "player_name": self.player_name, "rival_name": self.rival_name, "rng": self.rng.to_dict()}

    @classmethod
    def from_dict(cls, d, data=None, logger=None):
        g = cls.__new__(cls)
        g.data = data or GameData()
        g.logger = logger
        g.rng = RngHub.from_dict(d["rng"])
        for k in ("area_id", "x", "y", "money"):
            setattr(g, k, d[k])
        # あとから増えた項目は、古いセーブに無くても 新しく始めた時と同じ値で補って読む
        g.items, g.medals, g.steps, g.prompts = d.get("items", {}), d.get("medals", []), d.get("steps", 0), d.get("prompts", [])
        # 版で なくなった道具は 読み込まない（表示で 名前が 引けず 落ちるため）
        g.items = {k: v for k, v in g.items.items() if k in g.data.items}
        # 最後に休んだ場所は [場所, x, y]。無い・今は無い場所を指している・形が崩れている（手で直したセーブで、要素が足りない・座標が整数でない等）時は使わない
        h = d.get("last_heal")
        if not (isinstance(h, (list, tuple)) and len(h) >= 3 and isinstance(h[0], str) and h[0] in g.data.areas
                and type(h[1]) is int and type(h[2]) is int):
            h = None
        for k in ("area_actions", "idle_actions", "actions"):
            setattr(g, k, d.get(k, 0))
        g.facing = tuple(d.get("facing", (0, -1)))
        # 名前は 17周目で 増えた項目。古いセーブに無い時や、手で直して 決まりに合わない値の時は 空（未設定）で 読む
        try:
            g.player_name = cls.clean_name(d["player_name"]) if d.get("player_name") else ""
        except ActionError:
            g.player_name = ""
        # ライバル名は 今回 増えた項目。古いセーブ・決まりに合わない値は 既定（カナタ）で 読む
        try:
            g.rival_name = cls.clean_name(d["rival_name"]) if d.get("rival_name") else g.rival_default()
        except ActionError:
            g.rival_name = g.rival_default()
        g.party =[Monster.from_dict(g.data, m) for m in d["party"]]
        g.box = [Monster.from_dict(g.data, m) for m in d.get("box", [])]
        # 持たせられない道具（進化の道具 以外）を 持っていたら、Monster 側で 外した分を バッグへ 戻す。
        # 普通に遊んで 起きることは無い（手で直したセーブ・道具データの変更の時だけ）ので、黙って 直す
        for raw in list(d["party"]) + list(d.get("box", [])):
            held = raw.get("held") if isinstance(raw, dict) else None
            if isinstance(held, str) and held in g.data.items and g.data.items[held].get("kind") != "evolution":
                g.add_item(held)
        for k in ("flags", "seen", "caught", "defeated"):
            setattr(g, k, set(d.get(k, [])))
        # 石碑は 版で 増える。全部 読んだかは 読み込むたびに 今の石碑で 決め直す
        # （全部 読んだ 古いセーブは 条件を 満たし、石碑が 4つだった 頃に 立った旗は 持ち越さない）
        if g._tablets_all_read():
            g.flags.add("all_tablets_read")
        else:
            g.flags.discard("all_tablets_read")
        # 古いセーブ・途中の版のセーブで訪問地が欠けていても、いる場所と最後に休んだ場所（建物ならその町も）は行ったことのある場所に入れる
        g.visited = set(d.get("visited", [])) | g._with_town(g.area_id) | g._with_town(h[0] if h else g.area_id)
        g.battle = Battle.from_dict(g, dict(d["battle"])) if d.get("battle") else None
        # 前の版では歩けた建物の壁・入口の上でセーブしていても、読み込んだら近くの立てるマスへ移す（動けなくならないように）
        g.x, g.y = g._free_spot(g.x, g.y)
        # 最後に休んだ場所も同じ。前の版では休み処が外に置かれていて、話しかけた時の立ち位置（今は建物の壁）が入っていることがある。
        # 使えない時は、直した後の読み込んだ位置にする
        g.last_heal = [h[0], *g._free_spot(h[1], h[2], h[0])] if h else [g.area_id, g.x, g.y]
        return g

    def save(self, slot="auto"):
        if not str(slot).replace("_", "").replace("-", "").isalnum():
            raise ActionError("スロット名は英数字で")
        os.makedirs(save_dir(), exist_ok=True)
        path = os.path.join(save_dir(), f"{slot}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False)
        os.replace(tmp, path)
        return path

    @classmethod
    def load(cls, slot="auto", data=None, logger=None):
        if not str(slot).replace("_", "").replace("-", "").isalnum():
            raise ActionError("スロット名は英数字で")
        path = os.path.join(save_dir(), f"{slot}.json")
        if not os.path.exists(path):
            raise ActionError(f"セーブ「{slot}」は ない")
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f), data=data, logger=logger)
