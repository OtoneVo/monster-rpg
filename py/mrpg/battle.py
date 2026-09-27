"""ターン制バトル。第4〜5世代の計算式を再現。内部数値はメッセージに出さない。"""
from .monster import Monster, exp_yield, STATUS_NAMES

STAGE_NAMES = {"atk": "攻撃", "def": "防御", "spa": "特攻", "spd": "特防", "spe": "素早さ",
               "acc": "命中率", "eva": "回避率"}
WEATHER_NAMES = {"sun": "日差しが強い", "rain": "雨が降っている", "sand": "砂嵐が吹いている",
                 "snow": "雪が降っている", "fog": "濃い霧が立ちこめている"}
WEATHER_START = {"sun": "日差しが 強くなった！", "rain": "雨が 降りだした！", "sand": "砂嵐が 吹きはじめた！",
                 "snow": "雪が 降りだした！", "fog": "霧が 立ちこめた！"}
STATUS_MSG = {"sleep": "眠ってしまった！", "freeze": "凍りついた！", "paralysis": "まひして 技が出にくくなった！",
              "poison": "毒を あびた！", "toxic": "猛毒を あびた！", "burn": "やけどを 負った！"}
IMMUNE = {"burn": {"火"}, "freeze": {"氷"}, "paralysis": {"雷"}, "poison": {"毒", "晶"}, "toxic": {"毒", "晶"}}
CRIT_DIV = [16, 8, 2, 1]
STRUGGLE = {"name": "わるあがき", "type": None, "cat": "phys", "power": 50, "acc": None, "pp": 1}


class ActionError(Exception):
    """ターンを消費しない不正な指示"""


class _Recorded(list):
    """メッセージ1件ごとに、その時点の HP・状態を記録するリスト（画面の表示合わせ用）。
    状態は「そのメッセージを出した直後」。技の命中後は touch() で最後の1件を撮り直す"""

    def __init__(self, snap):
        super().__init__()
        self.snap = snap
        self.frames = []

    def append(self, m):
        super().append(m)
        self.frames.append(self.snap())

    def extend(self, ms):
        for m in ms:
            self.append(m)

    def touch(self):
        if self.frames:
            self.frames[-1] = self.snap()


def new_vol():
    return {"stages": {k: 0 for k in STAGE_NAMES}, "confuse": 0}


def stage_mult(s):
    return (2 + s) / 2 if s >= 0 else 2 / (2 - s)


def acc_stage_mult(s):
    s = max(-6, min(6, s))
    return (3 + s) / 3 if s >= 0 else 3 / (3 - s)


class Battle:
    def __init__(self, game, kind, enemies, trainer_id=None, legend=False, weather=None):
        self.g = game
        self.kind = kind  # wild | trainer | boss
        self.enemies = enemies
        self.trainer_id = trainer_id
        self.e_idx = 0
        self.p_idx = game.first_alive()
        self.p_vol = new_vol()
        self.e_vol = new_vol()
        self.base_weather = weather
        self.weather = weather
        self.weather_turns = 0
        self.turn = 1
        self.run_attempts = 0
        self.participants = [self.p_idx]
        self.state = "choose"  # choose | force_switch | offer_switch | over
        self.result = None     # win | lose | run | capture
        self.pending_e = None  # 倒れた相手の次に出てくる番号（ターンの最後に繰り出す）
        self.e_down = False    # いまの相手の「倒れた」処理が済んだか
        self.watch = game.data.config["battle"]["legend_watch_turns"] if legend else 0
        self.legend = legend
        self.money = 0
        self.captured = None
        self.log = []
        self.frames = []

    # ---- 参照 ----
    @property
    def data(self):
        return self.g.data

    @property
    def rng(self):
        return self.g.rng["battle"]

    @property
    def party(self):
        return self.g.party

    @property
    def player(self):
        return self.party[self.p_idx]

    @property
    def enemy(self):
        return self.enemies[self.e_idx]

    def snapshot(self):
        """内部の生の値。外へ出すときは web_server 側で相手 HP を段階に丸める"""
        p, e = self.player, self.enemy
        return {"p_idx": self.p_idx, "p_hp": p.hp, "p_max": p.maxhp, "p_status": p.status_label() or None,
                "e_idx": self.e_idx, "e_hp": e.hp, "e_max": e.maxhp, "e_status": e.status_label() or None}

    def _touch(self, msgs):
        if isinstance(msgs, _Recorded):
            msgs.touch()

    def label(self, side):
        if side == "p":
            return self.player.name
        prefix = "野生の " if self.kind == "wild" else "相手の "
        return prefix + self.enemy.name

    # ---- 行動（プレイヤー入力） ----
    def act(self, action):
        """action: {kind: move|switch|item|capture|run, ...}。メッセージのリストを返す"""
        if self.state == "over":
            raise ActionError("戦闘はもう終わっている")
        kind = action.get("kind")
        self.frames = []
        if self.state == "force_switch":
            msgs = _Recorded(self.snapshot)
            self.frames = msgs.frames
            if kind == "run" and self.kind == "wild":
                # 手持ちが倒れた直後の野生戦は、次を出さずに必ず逃げられる
                msgs.append("うまく 逃げ切れた！")
                self.state = "over"
                self.result = "run"
                return list(msgs)
            if kind != "switch":
                raise ActionError("次に出すモンスターを選んでください（switch）" if self.kind != "wild"
                                  else "次に出すモンスターを選ぶ（switch）か、逃げてください（run）")
            self._do_switch(action.get("index"), msgs, forced=True)
            self.state = "choose"
            return list(msgs)
        if self.state == "offer_switch":
            # 入れ替え戦: 相手が次を出す前に、こちらだけ交代できる
            msgs = _Recorded(self.snapshot)
            self.frames = msgs.frames
            if kind == "switch":
                self._validate(action)
                self._do_switch(action["index"], msgs)
            elif kind != "keep":
                raise ActionError("入れ替えるなら switch、そのまま戦うなら keep を選んでください")
            self.state = "choose"
            self._send_enemy(msgs)
            return list(msgs)
        self._validate(action)
        msgs = _Recorded(self.snapshot)
        self.frames = msgs.frames
        e_act = self._enemy_choice()
        # 技より先に処理する行動
        if kind == "run":
            if self._try_run(msgs):
                return list(msgs)
        elif kind == "switch":
            self._do_switch(action["index"], msgs)
        elif kind == "item":
            self._use_item(action["item"], action.get("target", self.p_idx), msgs)
        elif kind == "capture":
            if self._try_capture(action["item"], msgs):
                return list(msgs)
        movers = []
        if kind == "move":
            movers.append(("p", self.player, action["index"]))
        movers.append(("e", self.enemy, e_act))
        if len(movers) == 2:
            movers.sort(key=lambda m: self._order_key(m), reverse=True)
            a, b = movers
            if self._order_key(a)[:2] == self._order_key(b)[:2] and self.rng.below(2):
                movers = [b, a]
        for side, mon, choice in movers:
            if self.state != "choose":
                break
            cur = self.player if side == "p" else self.enemy
            if cur is not mon or mon.fainted:
                continue
            if self.enemy.fainted:
                break  # 相手が先に倒れた（次の相手はターンの最後に出てくる）
            if side == "e" and choice == "watch":
                msgs.append(f"{self.label('e')}は こちらの様子を うかがっている……")
                continue
            if side == "p":
                self._player_move(choice, msgs)
            else:
                self._use_move("e", choice, msgs)
            self._check_faints(msgs)
        if self.state in ("choose", "force_switch"):
            self._end_of_turn(msgs)  # こちらが倒れたターンも、生き残った側の やけど・どく・天気は 進む
        self._finish_turn(msgs)
        if self.watch > 0:
            self.watch -= 1
        self.turn += 1
        return list(msgs)

    def _validate(self, a):
        kind = a.get("kind")
        if kind == "move":
            i = a.get("index")
            mv = self.player.moves
            if all(m["pp"] <= 0 for m in mv):
                a["index"] = -1  # わるあがき
                return
            if not isinstance(i, int) or not (0 <= i < len(mv)):
                raise ActionError(f"技の番号は 0〜{len(mv) - 1} で指定してください")
            if mv[i]["pp"] <= 0:
                raise ActionError("その技は もう使えない（PP切れ）")
        elif kind == "switch":
            i = a.get("index")
            if not isinstance(i, int) or not (0 <= i < len(self.party)):
                raise ActionError("交代先の番号が正しくない")
            if i == self.p_idx:
                raise ActionError("そのモンスターは すでに戦っている")
            if self.party[i].fainted:
                raise ActionError("ひんしのモンスターは 出せない")
        elif kind in ("item", "capture"):
            it = a.get("item")
            if self.g.items.get(it, 0) <= 0:
                raise ActionError("その道具を持っていない")
            info = self.data.items[it]
            if kind == "capture" and info["kind"] != "capture":
                raise ActionError("それは捕獲器ではない")
            if kind == "item":
                if info["kind"] == "capture":
                    raise ActionError("捕獲器は capture で使ってください")
                if info["kind"] == "scroll":
                    raise ActionError("巻物は 戦闘中には 使えない")
                t = a.get("target", self.p_idx)
                if not isinstance(t, int) or not (0 <= t < len(self.party)):
                    raise ActionError("道具を使う相手の番号が正しくない")
                self.g.check_item_usable(it, self.party[t])
            if kind == "capture" and self.kind != "wild":
                raise ActionError("人のモンスターは捕まえられない！")
        elif kind == "run":
            if self.kind != "wild":
                raise ActionError("勝負の最中に 背中は見せられない！")
        else:
            raise ActionError("kind は move / switch / item / capture / run のどれか")

    def _order_key(self, m):
        side, mon, choice = m
        if choice == "watch":
            prio = -7
        elif choice == -1:
            prio = 0
        else:
            prio = self.data.moves[mon.moves[choice]["id"]].get("priority", 0)
        return (prio, self._eff_stat(side, "spe"), 0)

    # ---- 敵の思考 ----
    def _enemy_choice(self):
        e = self.enemy
        if self.watch > 0:
            return "watch"
        usable = [i for i, m in enumerate(e.moves) if m["pp"] > 0]
        if not usable:
            return -1
        if self.kind == "wild":
            return usable[self.rng.below(len(usable))]
        if self.rng.percent(self.data.config["battle"]["trainer_ai_random_percent"]):
            return usable[self.rng.below(len(usable))]
        best, best_score = usable[0], -1
        for i in usable:
            s = self._score_move(e.moves[i]["id"])
            if s > best_score:
                best, best_score = i, s
        return best

    def _score_move(self, mid):
        mv = self.data.moves[mid]
        e, p = self.enemy, self.player
        acc = (mv["acc"] or 100) / 100
        if mv["cat"] != "status":
            m = self.data.type_mult(mv["type"], p.types)
            stab = 1.5 if mv["type"] in e.types else 1.0
            return mv["power"] * m * stab * acc
        score = 0
        for ef in mv.get("effects", []):
            k = ef["kind"]
            if k == "status" and p.status is None and not (IMMUNE.get(ef["status"], set()) & set(p.types)):
                score = max(score, 45)
            elif k == "confuse" and self.p_vol["confuse"] == 0:
                score = max(score, 35)
            elif k == "stat":
                vol = self.e_vol if ef["target"] == "self" else self.p_vol
                if all(abs(vol["stages"][s]) < 4 for s in ef["stats"]):
                    score = max(score, 25)
            elif k == "weather" and self.weather != ef["weather"]:
                score = max(score, 20)
            elif k == "heal" and e.hp * 2 < e.maxhp:
                score = max(score, 70)
        return score * acc

    # ---- 技の実行 ----
    def _player_move(self, index, msgs):
        p = self.player
        if not self._can_act("p", msgs):
            return
        if not self._obeys():
            self._disobey(index, msgs)
            return
        if not self._confusion_check("p", msgs):
            return
        self._use_move("p", index, msgs, checked=True)

    def _obeys(self):
        p = self.player
        cap = self.g.obey_cap()
        over = p.level - cap
        if over <= 0:
            return True
        cfg = self.data.config["obey"]
        if over >= 21:
            return self.rng.next16() < cfg["over_21_obey_in_65536"]
        for lo, hi, plo, phi in cfg["bands"]:
            if lo <= over <= hi:
                pct = plo + (phi - plo) * (over - lo) / max(1, hi - lo)
                return self.rng.below(100) >= pct
        return True

    def _disobey(self, index, msgs):
        p = self.player
        name = p.name
        r = self.rng.below(4)
        if r == 0:
            msgs.append(f"{name}は 命令を無視して 知らんぷりしている……")
        elif r == 1:
            if p.status is None:
                p.status = "sleep"
                p.sleep_turns = self.rng.range(1, 3)
                msgs.append(f"{name}は 命令を無視して 昼寝を始めた！")
            else:
                msgs.append(f"{name}は 命令を無視して そっぽを向いた……")
        elif r == 2:
            others = [i for i, m in enumerate(p.moves) if m["pp"] > 0 and i != index]
            if others:
                msgs.append(f"{name}は 命令を無視して 勝手に動いた！")
                self._use_move("p", others[self.rng.below(len(others))], msgs, checked=True)
            else:
                msgs.append(f"{name}は 命令を無視して 知らんぷりしている……")
        else:
            msgs.append(f"{name}は 命令を無視して 混乱した！")
            self._self_hit("p", msgs)

    def _can_act(self, side, msgs):
        mon = self.player if side == "p" else self.enemy
        name = self.label(side)
        if mon.status == "sleep":
            mon.sleep_turns -= 1
            if mon.sleep_turns <= 0:
                mon.status = None
                msgs.append(f"{name}は 目を覚ました！")
            else:
                msgs.append(f"{name}は ぐうぐう 眠っている")
                return False
        if mon.status == "freeze":
            if self.rng.below(100) < 20:
                mon.status = None
                msgs.append(f"{name}の 氷が とけた！")
            else:
                msgs.append(f"{name}は 凍ってしまって 動けない！")
                return False
        if mon.status == "paralysis" and self.rng.below(4) == 0:
            msgs.append(f"{name}は 体がしびれて 動けない！")
            return False
        return True

    def _confusion_check(self, side, msgs):
        vol = self.p_vol if side == "p" else self.e_vol
        if vol["confuse"] <= 0:
            return True
        vol["confuse"] -= 1
        name = self.label(side)
        if vol["confuse"] == 0:
            msgs.append(f"{name}の 混乱が とけた！")
            return True
        msgs.append(f"{name}は 混乱している！")
        if self.rng.below(100) < self.data.config["battle"]["confuse_self_percent"]:
            msgs.append("わけも分からず 自分を攻撃した！")
            self._self_hit(side, msgs)
            return False
        return True

    def _self_hit(self, side, msgs):
        mon = self.player if side == "p" else self.enemy
        a = self._eff_stat(side, "atk")
        d = self._eff_stat(side, "def")
        dmg = ((2 * mon.level // 5 + 2) * 40 * a // max(1, d)) // 50 + 2
        mon.hp = max(0, mon.hp - dmg)
        self._touch(msgs)
        self._check_faints(msgs)

    def _use_move(self, side, index, msgs, checked=False):
        user = self.player if side == "p" else self.enemy
        target_side = "e" if side == "p" else "p"
        if not checked:
            if not self._can_act(side, msgs):
                return
            if not self._confusion_check(side, msgs):
                return
        if index == -1:
            mv, mid = STRUGGLE, None
        else:
            slot = user.moves[index]
            mid = slot["id"]
            mv = self.data.moves[mid]
            slot["pp"] = max(0, slot["pp"] - 1)
        target = self.player if target_side == "p" else self.enemy
        msgs.append(f"{self.label(side)}の {mv['name']}！")
        uvol = self.p_vol if side == "p" else self.e_vol
        tvol = self.p_vol if target_side == "p" else self.e_vol
        foe_targeted = mv["cat"] != "status" or any(
            ef["kind"] in ("status", "confuse") or (ef["kind"] == "stat" and ef["target"] == "foe")
            for ef in mv.get("effects", []))
        if foe_targeted and mv["acc"] is not None:
            acc = mv["acc"] * acc_stage_mult(uvol["stages"]["acc"] - tvol["stages"]["eva"])
            if self.weather == "fog":
                acc *= 0.8
            if self.rng.below(100) >= acc:
                msgs.append("しかし 攻撃は 外れた！" if mv["cat"] != "status" else "しかし うまく決まらなかった！")
                return
        if mv["cat"] != "status":
            mult = self.data.type_mult(mv["type"], target.types) if mv["type"] else 1.0
            if mult == 0:
                msgs.append(f"{self.label(target_side)}には 効果が ないようだ……")
                return
            dmg, crit = self._damage(side, target_side, mv, mult)
            target.hp = max(0, target.hp - dmg)
            self._touch(msgs)
            if crit:
                msgs.append("急所に 当たった！")
            if mult > 1:
                msgs.append("効果は 抜群だ！")
            elif mult < 1:
                msgs.append("効果は いまひとつのようだ……")
            if index == -1:
                user.hp = max(0, user.hp - max(1, user.maxhp // 4))
                msgs.append(f"{self.label(side)}は 反動を 受けた！")
            if target.fainted:
                return
            for ef in mv.get("effects", []):
                self._apply_effect(side, target_side, ef, msgs, secondary=True)
            return
        # 変化技
        if foe_targeted and self.data.type_mult(mv["type"], target.types) == 0:
            msgs.append(f"{self.label(target_side)}には 効果が ないようだ……")
            return
        any_ok = False
        for ef in mv.get("effects", []):
            if self._apply_effect(side, target_side, ef, msgs, secondary=False):
                any_ok = True
        if not any_ok:
            msgs.append("しかし うまく決まらなかった！")

    def _eff_stat(self, side, key):
        mon = self.player if side == "p" else self.enemy
        vol = self.p_vol if side == "p" else self.e_vol
        v = mon.stat(key) * stage_mult(vol["stages"][key])
        if key == "spe" and mon.status == "paralysis":
            v /= 2
        if key == "spd" and self.weather == "sand" and "岩" in mon.types:
            v *= 1.5
        return max(1, int(v))

    def _damage(self, side, tside, mv, mult):
        user = self.player if side == "p" else self.enemy
        crit_stage = min(3, mv.get("crit", 0))
        crit = self.rng.below(CRIT_DIV[crit_stage]) == 0
        if mv["cat"] == "phys":
            ak, dk = "atk", "def"
        else:
            ak, dk = "spa", "spd"
        uvol = self.p_vol if side == "p" else self.e_vol
        tvol = self.p_vol if tside == "p" else self.e_vol
        a = self._eff_stat(side, ak)
        d = self._eff_stat(tside, dk)
        if crit:  # 急所は不利なランクを無視
            if uvol["stages"][ak] < 0:
                a = self._raw_with_stage(side, ak, 0)
            if tvol["stages"][dk] > 0:
                d = self._raw_with_stage(tside, dk, 0)
        dmg = ((2 * user.level // 5 + 2) * mv["power"] * a // max(1, d)) // 50 + 2
        t = mv["type"]
        w = self.weather
        if (w == "sun" and t == "火") or (w == "rain" and t == "水") or (w == "fog" and t == "霧"):
            dmg = int(dmg * 1.5)
        elif (w == "sun" and t == "水") or (w == "rain" and t == "火") or (w == "fog" and t == "光"):
            dmg = int(dmg * 0.5)
        if crit:
            dmg = int(dmg * 1.5)
        dmg = dmg * (85 + self.rng.below(16)) // 100
        if t and t in user.types:
            dmg = int(dmg * 1.5)
        dmg = int(dmg * mult)
        if user.status == "burn" and mv["cat"] == "phys":
            dmg = int(dmg * 0.5)
        return max(1, dmg), crit

    def _raw_with_stage(self, side, key, stage):
        mon = self.player if side == "p" else self.enemy
        v = mon.stat(key) * stage_mult(stage)
        if key == "spd" and self.weather == "sand" and "岩" in mon.types:
            v *= 1.5
        return max(1, int(v))

    def _apply_effect(self, side, tside, ef, msgs, secondary):
        k = ef["kind"]
        chance = ef.get("chance", 100)
        if chance < 100 and self.rng.below(100) >= chance:
            return False
        target = self.player if tside == "p" else self.enemy
        user = self.player if side == "p" else self.enemy
        if k == "status":
            return self.try_status(tside, ef["status"], msgs, quiet=secondary)
        if k == "confuse":
            vol = self.p_vol if tside == "p" else self.e_vol
            if vol["confuse"] > 0:
                if not secondary:
                    msgs.append(f"{self.label(tside)}は すでに 混乱している")
                return False
            vol["confuse"] = self.rng.range(2, 5) + 1
            msgs.append(f"{self.label(tside)}は 混乱した！")
            return True
        if k == "stat":
            s_side = side if ef["target"] == "self" else tside
            vol = self.p_vol if s_side == "p" else self.e_vol
            ok = False
            for stat, delta in ef["stats"].items():
                key = "acc" if stat == "acc" else stat
                cur = vol["stages"][key]
                new = max(-6, min(6, cur + delta))
                name = STAGE_NAMES[key]
                if new == cur:
                    if not secondary:
                        msgs.append(f"{self.label(s_side)}の {name}は もう {'上がらない' if delta > 0 else '下がらない'}！")
                    continue
                vol["stages"][key] = new
                ok = True
                amt = abs(new - cur)
                word = ("ぐーんと " if amt >= 2 else "") + ("上がった！" if delta > 0 else "下がった！")
                if amt >= 2 and delta < 0:
                    word = "がくっと 下がった！"
                msgs.append(f"{self.label(s_side)}の {name}が {word}")
            return ok
        if k == "weather":
            w = ef["weather"]
            if self.weather == w and self.weather_turns > 0:
                return False
            self.weather = w
            self.weather_turns = self.data.config["battle"]["weather_turns"]
            msgs.append(WEATHER_START[w])
            return True
        if k == "heal":
            if user.hp >= user.maxhp:
                msgs.append(f"{self.label(side)}の 体力は 満タンだ")
                return False
            user.hp = min(user.maxhp, user.hp + max(1, int(user.maxhp * ef["ratio"])))
            msgs.append(f"{self.label(side)}は 体力を 回復した！")
            return True
        return False

    def try_status(self, tside, status, msgs, quiet=False):
        target = self.player if tside == "p" else self.enemy
        name = self.label(tside)
        if target.status is not None:
            if not quiet:
                msgs.append(f"{name}は すでに {STATUS_NAMES[target.status]}状態だ")
            return False
        if IMMUNE.get(status, set()) & set(target.types):
            if not quiet:
                msgs.append(f"{name}には 効かないようだ")
            return False
        if status == "sleep" and "夢" in target.types:
            if self.rng.below(100) < self.data.config["battle"]["dream_sleep_resist_percent"]:
                if not quiet:
                    msgs.append(f"{name}は 眠気を はねのけた！")
                return False
        target.status = status
        if status == "sleep":
            target.sleep_turns = self.rng.range(1, 3) + 1
        if status == "toxic":
            target.toxic_count = 0
        msgs.append(f"{name}は {STATUS_MSG[status]}")
        return True

    # ---- ターン終了 ----
    def _end_of_turn(self, msgs):
        for side in ("p", "e"):
            mon = self.player if side == "p" else self.enemy
            if mon.fainted:
                continue
            name = self.label(side)
            if self.weather == "sand" and not ({"岩", "金", "古"} & set(mon.types)):
                mon.hp = max(0, mon.hp - max(1, mon.maxhp // 16))
                msgs.append(f"砂嵐が {name}を 襲う！")
            elif self.weather == "snow" and "氷" not in mon.types:
                mon.hp = max(0, mon.hp - max(1, mon.maxhp // 16))
                msgs.append(f"雪が {name}を 凍えさせる！")
            if mon.fainted:
                continue
            if mon.status == "poison":
                mon.hp = max(0, mon.hp - max(1, mon.maxhp // 8))
                msgs.append(f"{name}は 毒の ダメージを受けている")
            elif mon.status == "toxic":
                mon.toxic_count += 1
                mon.hp = max(0, mon.hp - max(1, mon.maxhp * mon.toxic_count // 16))
                msgs.append(f"{name}は 猛毒の ダメージを受けている")
            elif mon.status == "burn":
                mon.hp = max(0, mon.hp - max(1, mon.maxhp // 16))
                msgs.append(f"{name}は やけどの ダメージを受けている")
        if self.weather_turns > 0:
            self.weather_turns -= 1
            if self.weather_turns == 0:
                self.weather = self.base_weather
                msgs.append("天気が 元に戻った" if self.base_weather else "空模様が 落ち着いた")
        self._check_faints(msgs)

    # ---- ひんし処理 ----
    def _check_faints(self, msgs):
        if self.state == "over":
            return
        if self.enemy.fainted and not self.e_down:
            self.e_down = True
            msgs.append(f"{self.label('e')}は 倒れた！")
            self._award_exp(msgs)
            nxt = next((i for i, m in enumerate(self.enemies) if not m.fainted), None)
            if nxt is None:
                if self.player.fainted and self.state == "choose":  # 相打ち: こちらも倒れたことを見せてから勝ち
                    msgs.append(f"{self.player.name}は 倒れた！")
                    self.participants = [i for i in self.participants if i != self.p_idx]
                self._win(msgs)
                return
            self.pending_e = nxt  # 繰り出すのはターンの最後（入れ替え戦の確認を挟むため）
        if self.player.fainted and self.state == "choose":
            msgs.append(f"{self.player.name}は 倒れた！")
            self.participants = [i for i in self.participants if i != self.p_idx]
            if self.g.first_alive() is None:
                self.state = "over"
                self.result = "lose"
                msgs.append("戦えるモンスターが いなくなった……目の前が 真っ暗になった！")
            else:
                self.state = "force_switch"

    def _bench_ready(self):
        return any(i != self.p_idx and not m.fainted for i, m in enumerate(self.party))

    def _finish_turn(self, msgs):
        """ターンの最後: 相手の次のモンスターと、こちらの交代の案内"""
        if self.state == "over":
            return
        if self.pending_e is not None:
            if self.state == "choose" and self._bench_ready():
                nm = self.enemies[self.pending_e]
                tname = self.data.trainers[self.trainer_id]["name"]
                msgs.append(f"{tname}は {nm.name}（Lv{nm.level}）を 繰り出そうとしている。")
                msgs.append("モンスターを 入れ替えますか？")
                self.state = "offer_switch"
                return
            self._send_enemy(msgs)
        if self.state == "force_switch":
            msgs.append("次の モンスターを 出しますか？（逃げることも できる）" if self.kind == "wild"
                        else "次に出すモンスターを 選んでください")

    def _send_enemy(self, msgs):
        if self.pending_e is None:
            return
        self.e_idx = self.pending_e
        self.pending_e = None
        self.e_down = False
        self.e_vol = new_vol()
        self.participants = [self.p_idx] if not self.player.fainted else []
        tname = self.data.trainers[self.trainer_id]["name"]
        msgs.append(f"{tname}は {self.enemy.name}（Lv{self.enemy.level}）を 繰り出した！")

    def _award_exp(self, msgs):
        foe = self.enemy
        alive = [i for i in dict.fromkeys(self.participants) if not self.party[i].fainted]
        trainer = self.kind != "wild"
        for i in alive:
            mon = self.party[i]
            amt = exp_yield(self.data, foe, mon.level, trainer, len(alive))
            msgs.append(f"{mon.name}は {amt} の 経験値を もらった！")
            self._give_exp(i, mon, foe, amt, msgs)
        # わけあいの鈴: 戦闘に 出ていない 元気な 仲間にも 分ける（出た仲間の 取り分は 減らさない）
        if not alive or not self.g.wakeai_active():
            return
        bench = [i for i, m in enumerate(self.party) if i not in alive and not m.fainted and m.level < 100]
        if not bench:
            return
        msgs.append("わけあいの鈴の 音で ほかの 仲間も 経験値を もらった！")
        for i in bench:
            mon = self.party[i]
            amt = exp_yield(self.data, foe, mon.level, trainer, len(alive) * 2)
            self._give_exp(i, mon, foe, amt, msgs)

    def _give_exp(self, i, mon, foe, amt, msgs):
        mon.add_evs(foe.sp["ev"])
        ups = mon.gain_exp(amt)
        for lv in ups:
            msgs.append(f"{mon.name}は Lv{lv} に 上がった！")
            for mv in mon.new_moves_on(lv):
                if mon.learn(mv):
                    msgs.append(f"{mon.name}は {self.data.moves[mv]['name']}を 覚えた！")
                else:
                    self.g.queue_prompt({"kind": "learn_move", "party": i, "move": mv})
                    msgs.append(f"{mon.name}は {self.data.moves[mv]['name']}を 覚えたがっている（戦闘後に選択）")
            self.g.note_progress(f"{mon.name} Lv{lv}")
        if ups and mon.can_evolve():
            self.g.queue_prompt({"kind": "evolve", "party": i})

    def _win(self, msgs):
        self.state = "over"
        self.result = "win"
        if self.kind != "wild":
            t = self.data.trainers[self.trainer_id]
            if t.get("boss"):
                self.money = t["money_per_level"] * max(m.level for m in self.enemies)
            else:
                self.money = t["money"]
            msgs.append(f"{t['name']}との 勝負に 勝った！")
            msgs.append(t["lose"])
            msgs.append(f"賞金として {self.money} 円 手に入れた！")

    # ---- 交代・道具・捕獲・逃走 ----
    def _do_switch(self, index, msgs, forced=False):
        if not isinstance(index, int) or not (0 <= index < len(self.party)) or self.party[index].fainted \
                or index == self.p_idx:
            raise ActionError("その番号のモンスターは 出せない")
        if not forced:
            msgs.append(f"戻れ、{self.player.name}！")
        self.p_idx = index
        self.p_vol = new_vol()
        if index not in self.participants:
            self.participants.append(index)
        msgs.append(f"行け、{self.player.name}！")

    def _use_item(self, item, target, msgs):
        self.g.consume_item(item)
        msgs.extend(self.g.apply_item(item, self.party[target]))

    def _try_run(self, msgs):
        self.run_attempts += 1
        ps = self._eff_stat("p", "spe")
        es = self._eff_stat("e", "spe")
        if ps >= es:
            ok = True
        else:
            f = (ps * 128 // max(1, es) + 30 * self.run_attempts) % 256
            ok = self.rng.below(256) < f
        if ok:
            msgs.append("うまく 逃げ切れた！")
            self.state = "over"
            self.result = "run"
            return True
        msgs.append("逃げられなかった！")
        return False

    def capture_chance(self, item):
        """0.0〜1.0。内部値なので外には出さない"""
        info = self.data.items[item]["capture"]
        e, p = self.enemy, self.player
        cfg = self.data.config["capture"]
        mode = info["mode"]
        if mode == "master":
            return 1.0
        dev = 1.0
        if mode == "flat":
            dev = info["mult"]
        elif mode == "night":
            dev = info["mult"] if (self.g.phase() == "夜" or self.g.area.get("cave")) else 1.0
        elif mode == "first_turn":
            dev = info["mult"] if self.turn == 1 else 1.0
        elif mode == "type":
            dev = info["mult"] if info["type"] in e.types else 1.0
        elif mode == "legend":
            dev = info["mult"] if self.legend else 1.0
        rate = e.sp["catch_rate"] / 255
        hpf = cfg["hp_top"] - e.hp / e.maxhp
        stf = cfg["status"].get(e.status, 1.0)
        lvf = 1.0 if mode == "ignore_level" else min(1.0, p.level / e.level)
        medf = min(1.0, cfg["medal_base"] + cfg["medal_step"] * len(self.g.medals))
        return min(1.0, max(cfg["min"], rate * hpf * stf * dev * lvf * medf))

    def _try_capture(self, item, msgs):
        self.g.consume_item(item)
        name = self.data.items[item]["name"]
        msgs.append(f"{name}を 投げた！")
        p = self.capture_chance(item)
        roll = self.g.rng["capture"].next16()
        if roll < int(p * 65536) or p >= 1.0:
            msgs.append(f"やった！ {self.enemy.name}を 捕まえた！")
            self.state = "over"
            self.result = "capture"
            self.captured = self.enemy
            return True
        shakes = min(3, int(p * 4 + (roll % 2)))
        msgs.append(["ああっ！ すぐに 飛び出してしまった！", "ああっ！ 少し 揺れたけど 飛び出した！",
                     "あと少しだったのに！", "あーっ！ ほとんど 捕まえたと思ったのに！"][shakes])
        return False

    # ---- 保存 ----
    def to_dict(self):
        return {"kind": self.kind, "enemies": [m.to_dict() for m in self.enemies], "trainer_id": self.trainer_id,
                "e_idx": self.e_idx, "p_idx": self.p_idx, "p_vol": self.p_vol, "e_vol": self.e_vol,
                "base_weather": self.base_weather, "weather": self.weather, "weather_turns": self.weather_turns,
                "turn": self.turn, "run_attempts": self.run_attempts, "participants": self.participants,
                "state": self.state, "result": self.result, "watch": self.watch, "legend": self.legend,
                "money": self.money, "pending_e": self.pending_e, "e_down": self.e_down}

    @classmethod
    def from_dict(cls, game, d):
        b = cls.__new__(cls)
        b.g = game
        b.enemies = [Monster.from_dict(game.data, m) for m in d.pop("enemies")]
        b.pending_e, b.e_down = None, False  # 古いセーブ向けの既定値
        for k, v in d.items():
            setattr(b, k, v)
        b.captured = None
        b.log = []
        b.frames = []
        return b
