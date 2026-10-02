"""画面・状態の文字表示。内部数値（相性倍率・種族値・捕獲率）は出さない。"""
import unicodedata

VIEW_W, VIEW_H = 17, 11
TILE_LEGEND = {"#": "壁", "D": "家具", ".": "道", ",": "草むら", ":": "洞窟の床", "R": "大岩", "T": "茂み", "~": "水",
               "K": "暗闇", "M": "重い扉", "E": "電気の柵", "W": "崖", "F": "吹雪"}
OBJ_CHARS = {"exit": ">", "lab": "L", "heal": "H", "shop": "S", "gym": "G", "npc": "N", "trainer": "!",
             "tablet": "?", "box": "B", "item": "*", "static": "&"}
OBJ_LEGEND = {">": "出口", "L": "研究所", "H": "休み処", "S": "店", "G": "道場", "N": "人・看板",
              "!": "トレーナー", "?": "石碑", "B": "あずかり箱", "*": "落とし物", "&": "ふしぎな気配"}


def hp_bar(cur, mx, width=20):
    filled = 0 if cur <= 0 else max(1, round(width * cur / mx))
    return "[" + "#" * filled + "-" * (width - filled) + "]"


def type_paren(types):
    # タイプのない種（ハジメ）は 括弧ごと 出さない（Web の タイプ札と 同じ）
    return f" ({'・'.join(types)})" if types else ""


def mon_line(m, i=None, show_hp=True):
    head = f"{i}: " if i is not None else ""
    st = m.status_label()
    st = f" [{st}]" if st else ""
    shiny = "★" if m.shiny else ""
    hp = f" HP {m.hp}/{m.maxhp}" if show_hp else ""
    return f"{head}{shiny}{m.name} Lv{m.level}{type_paren(m.types)}{hp}{st}"


def move_lines(g, m):
    out = []
    for i, mv in enumerate(m.moves):
        d = g.data.moves[mv["id"]]
        cat = {"phys": "物理", "spec": "特殊", "status": "変化"}.get(d["cat"], d["cat"])
        pw = f" 威力{d['power']}" if d.get("power") else ""
        out.append(f"   技{i}: {d['name']}（{d['type']}/{cat}{pw}） PP {mv['pp']}/{d['pp']}")
    return out


def map_window(g):
    a = g.area
    h, w = len(a["map"]), len(a["map"][0])
    x0 = max(0, min(g.x - VIEW_W // 2, w - VIEW_W)) if w > VIEW_W else 0
    y0 = max(0, min(g.y - VIEW_H // 2, h - VIEW_H)) if h > VIEW_H else 0
    objs = {(o["x"], o["y"]): "N" if o.get("person") else OBJ_CHARS[o.get("building") or o["kind"]]
            for o in a["objects"] if g.object_visible(o)}
    rows, used = [], set()
    for y in range(y0, min(h, y0 + VIEW_H)):
        row = ""
        for x in range(x0, min(w, x0 + VIEW_W)):
            if (x, y) == (g.x, g.y):
                ch = "@"
            elif (x, y) in objs:
                ch = objs[(x, y)]
            elif [x, y] in a.get("blocked", ()):
                ch = "#"  # 建物の壁（入口だけが記号で出る）
            else:
                ch = a["map"][y][x]
                if ch in g.data.gates and g.unlocked(ch):
                    ch = "."
            used.add(ch)
            row += ch
        rows.append(row)
    legend = ["@=自分"] + [f"{c}={n}" for c, n in {**TILE_LEGEND, **OBJ_LEGEND}.items() if c in used]
    return rows, "  ".join(legend)


def field_screen(g):
    rows, legend = map_window(g)
    face = {(0, -1): "北", (0, 1): "南", (-1, 0): "西", (1, 0): "東"}[g.facing]
    out = [f"■ {g.area['name']}（{g.x},{g.y}） 向き:{face}  時間帯:{g.phase()}  所持金:{g.money}円  メダル:{len(g.medals)}"]
    out.append("  (上が北。x は右へ、y は下へ増える)")
    out += ["  " + r for r in rows]
    out.append("  " + legend)
    fo = g.facing_object()
    if fo and fo["kind"] != "exit":
        out.append(f"  目の前: {fo.get('label', '')}（interact で調べる）")
    return "\n".join(out)


def battle_screen(g):
    b = g.battle
    e, p = b.enemy, b.player
    if b.kind == "wild":
        head = "野生の"
    else:
        head = g.trainer_name(b.trainer_id) + "の "
        left = sum(1 for m in b.enemies if not m.fainted)
        head = f"{g.trainer_name(b.trainer_id)}（残り{left}匹）の "
    st = e.status_label()
    wmap = {"sun": "日差しが強い", "rain": "雨", "fog": "霧", "sand": "砂嵐", "snow": "雪"}
    out = [f"■ 戦闘 ターン{b.turn}" + (f"  天気:{wmap.get(b.weather, b.weather)}" if b.weather else "")]
    out.append(f"  相手: {head}{'★' if e.shiny else ''}{e.name} Lv{e.level}{type_paren(e.types)}"
               f"{' [' + st + ']' if st else ''}")
    out.append(f"        HP {hp_bar(e.hp, e.maxhp)}")
    out.append(f"  自分: {mon_line(p)}")
    out.append(f"        HP {hp_bar(p.hp, p.maxhp)}")
    out += move_lines(g, p)
    if b.state == "force_switch":
        out.append("  → 次に出すモンスターを選ぶ（switch）" + ("か、逃げる（run）" if b.kind == "wild" else ""))
    elif b.state == "offer_switch":
        out.append("  → 相手が次を出す前に 入れ替える（switch）か、そのまま戦う（keep）")
    else:
        cmds = "move / switch / item" + (" / capture / run" if b.kind == "wild" else "")
        out.append(f"  コマンド: {cmds}")
    return "\n".join(out)


def prompt_screen(g):
    v = g.prompt_view()
    if not v:
        return ""
    out = ["■ 選択: " + v["text"]]
    out += [f"  {i}: {o}" for i, o in enumerate(v["options"])]
    return "\n".join(out)


def screen(g):
    parts = [battle_screen(g) if g.battle else field_screen(g)]
    if g.prompts and not g.battle:
        parts.append(prompt_screen(g))
    w = g.stuck_warning()
    if w:
        parts.append(w)
    return "\n".join(parts)


def world_view(g):
    """たびの地図: 行ったことのある場所だけ名前・id・町かどうかを出す（行っていない所は ？？？、id も伏せる）。
    つながりは 屋外どうしの出口のうち、片方でも行ったことのある場所から出ているものだけ（？？？どうしは出さない）。
    マスは 行ったことのある場所と、そこから つながっている ？？？ だけに絞る（地方が広いので 先の方は出さない）。
    Web・CLI・MCP で共通"""
    wm = g.data.world_map
    here = g.area.get("parent") or g.area_id
    key, cells = {}, []
    for n, (aid, (col, row)) in enumerate(wm["cells"].items()):
        seen = aid in g.visited
        key[aid] = aid if seen else f"?{n}"
        cells.append({"id": key[aid], "col": col, "row": row, "name": g.data.areas[aid]["name"] if seen else "？？？",
                      "visited": seen, "here": aid == here, "town": seen and aid in wm.get("towns", [])})
    edges = set()
    for aid, a in g.data.areas.items():
        if aid not in wm["cells"]:
            continue
        for o in a["objects"]:
            if o["kind"] == "exit" and o["to"] in wm["cells"] and (aid in g.visited or o["to"] in g.visited):
                edges.add(tuple(sorted((key[aid], key[o["to"]]))))
    ends = {x for e in edges for x in e}
    cells = [c for c in cells if c["visited"] or c["here"] or c["id"] in ends]
    return {"cells": cells, "edges": [list(e) for e in sorted(edges)]}


def _width(s):
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)


def world_lines(g):
    """たびの地図の文字版（上が北）。マスの並びと、道のつながり"""
    v = world_view(g)
    label = {c["id"]: ("★" if c["here"] else "") + c["name"] for c in v["cells"]}
    at = {(c["col"], c["row"]): c for c in v["cells"]}
    w = max(_width(s) for s in label.values()) + 1
    out = ["たびの地図（上が北／★ いまここ）"]
    c0 = min(c["col"] for c in v["cells"])
    for r in range(min(c["row"] for c in v["cells"]), max(c["row"] for c in v["cells"]) + 1):
        row = ""
        for col in range(c0, max(c["col"] for c in v["cells"]) + 1):
            s = label[at[(col, r)]["id"]] if (col, r) in at else ""
            row += s + " " * (w - _width(s))
        out.append(" " + row.rstrip())
    # 道のつながりは world_view の時点で 行ったことのある場所から出ているものだけ（？？？どうしは出ない）
    out.append("つながり: " + ("、".join(f"{label[a]}―{label[b]}" for a, b in v["edges"]) or "なし"))
    return out


def dex_habitats(g):
    """図鑑の すみか: 見た・捕まえた種ごとに、出る場所（行っていない所は ？？？、分からなければ 不明）"""
    return {g.data.species[s]["name"]: (g.habitats(s) or ["不明"]) for s in sorted(g.seen | g.caught)}


def dex_lines(g):
    """CLI の dex: 図鑑の件数と すみか"""
    out = [f"図鑑: 見た{len(g.seen)} 捕まえた{len(g.caught)}"]
    for name, places in dex_habitats(g).items():
        out.append(f" {name}: {'・'.join(places)}")
    return out


def state_dict(g):
    """MCP get_state 用。内部数値は含めない"""
    rows, legend = map_window(g)
    d = {
        "location": {"area": g.area["name"], "x": g.x, "y": g.y,
                     "facing": {(0, -1): "北", (0, 1): "南", (-1, 0): "西", (1, 0): "東"}[g.facing],
                     "time_of_day": g.phase(), "weather": g.area.get("weather")},
        "nearby_map": rows, "map_legend": legend,
        "party": [{"index": i, "name": m.name, "level": m.level, "types": m.types, "hp": m.hp, "max_hp": m.maxhp,
                   "status": m.status_label() or None,
                   "held": g.data.items[m.held]["name"] if m.held else None,
                   "moves": [{"name": g.data.moves[mv["id"]]["name"], "type": g.data.moves[mv["id"]]["type"],
                              "pp": mv["pp"], "max_pp": g.data.moves[mv["id"]]["pp"]} for mv in m.moves]}
                  for i, m in enumerate(g.party)],
        "box_count": len(g.box),
        "box": [{"index": i, "name": m.name, "level": m.level, "types": m.types} for i, m in enumerate(g.box)],
        "items": {g.data.items[k]["name"] + f" ({k})": v for k, v in sorted(g.items.items())},
        "money": g.money,
        "medals": [g.data.medals[t]["name"] for t in g.medals],
        "flags": sorted(f for f in g.flags if not f.startswith("starter_")),
        "dex": {"seen": len(g.seen), "caught": len(g.caught), "habitats": dex_habitats(g)},
        "player_name": g.player_name,
        "rival_name": g.rival_name,
        "obey_level_cap": g.obey_cap(),
        "in_battle": bool(g.battle),
        "pending_prompt": g.prompt_view() if not g.battle else None,
    }
    fo = g.facing_object()
    if fo and fo["kind"] != "exit":
        d["facing_object"] = g.fmt(fo.get("label"))  # {rival} を 名前に
    if g.items.get("tabichizu", 0) > 0:
        d["world_map"] = world_lines(g)
    if g.items.get("wakeai_suzu", 0) > 0:
        d["wakeai_suzu"] = "ON" if g.wakeai_active() else "OFF"
    w = g.stuck_warning()
    if w:
        d["warning"] = w
    return d
