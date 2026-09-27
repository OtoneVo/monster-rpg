"""プレイログ（jsonl＝機械用、md＝note 記事用に人が読む形）。"""
import datetime
import json
import os

DEFAULT_LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")


class PlayLogger:
    def __init__(self, tag="play", log_dir=None):
        d = log_dir or os.environ.get("MONSTER_RPG_LOG_DIR") or DEFAULT_LOG_DIR
        os.makedirs(d, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        self.jsonl = os.path.join(d, f"{stamp}_{tag}.jsonl")
        self.md = os.path.join(d, f"{stamp}_{tag}.md")
        with open(self.md, "a", encoding="utf-8") as f:
            f.write(f"# プレイログ {stamp}（{tag}）\n\n")

    def event(self, kind, /, **kw):
        rec = {"t": datetime.datetime.now().isoformat(timespec="seconds"), "event": kind, **kw}
        with open(self.jsonl, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        if kind in ("new_game", "battle_start", "battle_end", "enter_area", "demo_clear", "remix"):
            detail = ", ".join(f"{k}={v}" for k, v in kw.items())
            with open(self.md, "a", encoding="utf-8") as f:
                f.write(f"\n> [{kind}] {detail}\n\n")

    def action(self, tool, args, reason, messages):
        """AI（または人）の行動と理由、結果を md に残す"""
        self.event("action", tool=tool, args=args, reason=reason, messages=messages)
        a = ", ".join(f"{k}={v}" for k, v in args.items() if k != "reason")
        with open(self.md, "a", encoding="utf-8") as f:
            f.write(f"- **{tool}**({a})" + (f" — 理由: {reason}" if reason else "") + "\n")
            for m in messages:
                f.write(f"  - {m}\n")
