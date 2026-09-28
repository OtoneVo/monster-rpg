"""個体（モンスター1体）。能力値・経験値・技の管理。"""
import math

STATS = ("hp", "atk", "def", "spa", "spd", "spe")
STATUS_NAMES = {"sleep": "ねむり", "freeze": "こおり", "paralysis": "まひ", "poison": "どく",
                "toxic": "もうどく", "burn": "やけど"}


def exp_for_level(growth, n):
    if n <= 1:
        return 0
    if growth == "fast":
        return int(0.8 * n ** 3)
    if growth == "medium_fast":
        return n ** 3
    if growth == "slow":
        return int(1.25 * n ** 3)
    # medium（第三世代の「やや遅い」曲線相当）
    return max(0, int(1.2 * n ** 3 - 15 * n ** 2 + 100 * n - 140))


def friendship_cfg(data):
    """なつき度の設定（config.friendship）。無い時は既定値"""
    cfg = {"base": 70, "max": 255, "evolve": 160, "level_up": 10, "win": 2}
    cfg.update({k: v for k, v in data.config.get("friendship", {}).items() if not k.startswith("_")})
    return cfg


class Monster:
    def __init__(self, data, species, level, rng=None, ivs=None, nature=None, shiny=False):
        self.data = data
        self.species = species
        self.level = level
        sp = data.species[species]
        self.exp = exp_for_level(sp["growth"], level)
        if ivs is None:
            ivs = [rng.below(32) for _ in STATS] if rng else [15] * 6
        self.ivs = list(ivs)
        self.evs = [0] * 6
        if nature is None:
            nature = rng.below(len(data.natures)) if rng else 0
        self.nature = nature
        self.shiny = shiny
        self.status = None
        self.sleep_turns = 0
        self.toxic_count = 0
        self.friendship = friendship_cfg(data)["base"]  # なつき度（プレイ画面には数値を出さない）
        self.held = None  # 持たせている道具の id（持たせて進化 用。進化の道具だけ）
        self.moves = []
        self.reset_moves()
        self.hp = self.stat("hp")

    # ---- 基本情報 ----
    @property
    def sp(self):
        return self.data.species[self.species]

    @property
    def name(self):
        return self.sp["name"]

    @property
    def types(self):
        return self.sp["types"]

    def stat(self, key):
        i = STATS.index(key)
        base = self.sp["base"][i]
        core = (2 * base + self.ivs[i] + self.evs[i] // 4) * self.level // 100
        if key == "hp":
            return core + self.level + 10
        v = core + 5
        nat = self.data.natures[self.nature]
        if nat["up"] == key:
            v = v * 110 // 100
        elif nat["down"] == key:
            v = v * 90 // 100
        return v

    @property
    def maxhp(self):
        return self.stat("hp")

    @property
    def fainted(self):
        return self.hp <= 0

    # ---- 技 ----
    def moves_at_level(self, level):
        learned = []
        for lv, mv in self.sp["learnset"]:
            if lv <= level and mv not in learned:
                learned.append(mv)
        return learned[-4:]

    def reset_moves(self, level=None):
        """指定レベル時点で覚えている構成に入れ替える（捕獲時の上限引き下げ用）"""
        lv = self.level if level is None else level
        self.moves = [{"id": m, "pp": self.data.moves[m]["pp"]} for m in self.moves_at_level(lv)]

    def new_moves_on(self, level):
        known = {m["id"] for m in self.moves}
        return [mv for lv, mv in self.sp["learnset"] if lv == level and mv not in known]

    def learn(self, move_id, replace_index=None):
        entry = {"id": move_id, "pp": self.data.moves[move_id]["pp"]}
        if replace_index is None:
            if len(self.moves) >= 4:
                return False
            self.moves.append(entry)
        else:
            self.moves[replace_index] = entry
        return True

    # ---- レベル ----
    def set_level(self, level):
        """レベルを直接設定（捕獲時の引き下げ等）。HP は割合を保つ"""
        ratio = self.hp / self.maxhp if self.maxhp else 1
        self.level = level
        self.exp = exp_for_level(self.sp["growth"], level)
        self.hp = max(1, int(self.maxhp * ratio)) if self.hp > 0 else 0

    def gain_exp(self, amount):
        """経験値を加算し、上がったレベルのリストを返す"""
        ups = []
        self.exp += amount
        while self.level < 100 and self.exp >= exp_for_level(self.sp["growth"], self.level + 1):
            old_max = self.maxhp
            self.level += 1
            self.hp += self.maxhp - old_max
            ups.append(self.level)
        return ups

    def add_evs(self, ev):
        total = sum(self.evs)
        for k, v in ev.items():
            i = STATS.index(k)
            add = min(v, 252 - self.evs[i], 510 - total)
            if add > 0:
                old_max = self.maxhp
                self.evs[i] += add
                total += add
                if k == "hp":
                    self.hp += self.maxhp - old_max

    def add_friendship(self, n):
        cfg = friendship_cfg(self.data)
        self.friendship = max(0, min(cfg["max"], self.friendship + n))

    def evolve(self, into=None):
        ev = self.sp.get("evolve") or {}
        into = into or ev["into"]
        if ev.get("method") == "held_item" and ev.get("into") == into and self.held == ev.get("item"):
            self.held = None  # 持たせた道具は 進化で なくなる
        old_max = self.maxhp
        self.species = into
        self.hp += self.maxhp - old_max

    def can_evolve(self, game=None, item=None):
        """進化できるなら進化先の id、できなければ None。
        evolve に書いてある条件を全部満たした時だけ進化する（method 省略＝レベル進化）。
        道具進化（method=item）は、その道具を使った時（item 指定）だけ。道具を使った時は道具進化以外は起きない。
        持たせて進化（method=held_item）は、その道具を持たせた状態の レベルアップ等（item 指定なし）で起きる"""
        ev = self.sp.get("evolve")
        if not ev:
            return None
        if (ev.get("method") == "item") != (item is not None):
            return None
        if item is not None and ev.get("item") != item:
            return None
        if ev.get("method") == "held_item" and self.held != ev.get("item"):
            return None
        if ev.get("level") is not None and self.level < ev["level"]:
            return None
        if ev.get("friendship") and self.friendship < friendship_cfg(self.data)["evolve"]:
            return None
        if ev.get("time") and (game is None or game.phase() != ev["time"]):
            return None
        if ev.get("place") and (game is None or ev["place"] not in game.place_tags()):
            return None
        known = [m["id"] for m in self.moves]
        if ev.get("move") and ev["move"] not in known:
            return None
        if ev.get("move_type") and not any(self.data.moves[m]["type"] == ev["move_type"] for m in known):
            return None
        return ev["into"]

    def heal_full(self):
        self.hp = self.maxhp
        self.status = None
        self.sleep_turns = 0
        self.toxic_count = 0
        for m in self.moves:
            m["pp"] = self.data.moves[m["id"]]["pp"]

    def status_label(self):
        if self.fainted:
            return "ひんし"
        return STATUS_NAMES.get(self.status, "")

    # ---- 保存 ----
    def to_dict(self):
        return {"species": self.species, "level": self.level, "exp": self.exp, "ivs": self.ivs,
                "evs": self.evs, "nature": self.nature, "shiny": self.shiny, "hp": self.hp,
                "status": self.status, "sleep_turns": self.sleep_turns, "toxic_count": self.toxic_count,
                "moves": self.moves, "friendship": self.friendship, "held": self.held}

    @classmethod
    def from_dict(cls, data, d):
        m = cls.__new__(cls)
        m.data = data
        for k in ("species", "level", "exp", "ivs", "evs", "nature", "shiny", "hp", "status",
                  "sleep_turns", "toxic_count", "moves"):
            setattr(m, k, d[k])
        m.friendship = d.get("friendship", friendship_cfg(data)["base"])  # 古いセーブ向けの既定値
        held = d.get("held")
        ok = isinstance(held, str) and data.items.get(held, {}).get("kind") == "evolution"
        m.held = held if ok else None  # 版で なくなった道具・持たせられない道具を 持っていたら 外す（give_item と同じ条件）
        return m


def level_diff_exp_factor(cfg, my_level, foe_level):
    """経験値のレベル差補正。格上ボーナス／同程度等倍／格下は大きく減る"""
    diff = foe_level - my_level
    if diff > 0:
        return min(1 + cfg["up_per_level"] * diff, cfg["up_max"])
    down = -diff
    if down >= cfg["down_floor_diff"]:
        return cfg["down_floor"]
    if down <= cfg["down_free"]:
        return 1.0
    return max(cfg["down_floor"], cfg["down_decay"] ** (down - cfg["down_free"]))


def exp_yield(data, foe, my_level, trainer, share):
    cfg = data.config["exp"]
    base = foe.sp["base_exp"] * foe.level / 7 * cfg["scale"]
    if trainer:
        base *= cfg["trainer_bonus"]
    base *= level_diff_exp_factor(cfg, my_level, foe.level)
    return max(1, math.floor(base / max(1, share)))
