"""data/*.json の読み込みと参照整合チェック。数値はすべて JSON 側に置く。"""
import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def _load(name):
    with open(os.path.join(DATA_DIR, name), encoding="utf-8") as f:
        return json.load(f)


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
RIVAL_NPC = {"x": 7, "y": 3, "kind": "npc", "label": "カナタ", "person": "rival", "hide_flag": "rival_1_done",
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
            objs = [{"x": door, "y": h - 1, "kind": "exit", "to": town, "tx": o["x"], "ty": o["y"] + 1}, staff]
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
        _add_interiors(self.areas)
        tr = _load("trainers.json")
        self.trainers = tr["trainers"]
        self.medals = tr["medals"]

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
            if ev and ev["into"] not in self.species:
                errs.append(f"species {sid}: unknown evolve target {ev['into']}")
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
                give = o.get("give")
                if give:
                    if give.get("item") not in self.items:
                        errs.append(f"area {aid}: unknown give item {give.get('item')}")
                    for key in ("flag", "text_give"):
                        if not give.get(key):
                            errs.append(f"area {aid}: give missing {key} {o.get('label')}")
                    if give.get("need_medal") and not give.get("text_before"):
                        errs.append(f"area {aid}: give missing text_before {o.get('label')}")
                    if give.get("need_medal") and give["need_medal"] not in self.medals:
                        errs.append(f"area {aid}: give unknown medal {give['need_medal']}")
        for aid in list(self.world_map["cells"]) + self.world_map.get("towns", []):
            if aid not in self.areas or self.areas[aid].get("interior"):
                errs.append(f"world_map: unknown outdoor area {aid}")
        for iid, it in self.items.items():
            if it["kind"] == "scroll" and it.get("move") not in self.moves:
                errs.append(f"item {iid}: unknown scroll move {it.get('move')}")
        for tid, t in self.trainers.items():
            if t.get("reward_item") and t["reward_item"] not in self.items:
                errs.append(f"trainer {tid}: unknown reward_item {t['reward_item']}")
            parties = [t["party"]] if "party" in t else list(t.get("party_by_starter", {}).values())
            for p in parties:
                for sp, _ in p:
                    if sp not in self.species:
                        errs.append(f"trainer {tid}: unknown species {sp}")
        return errs
