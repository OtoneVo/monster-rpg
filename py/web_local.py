"""静的配信版（ブラウザ内 Python）用のつなぎ。

web_server.py の Session と payload 関数をそのまま使い、HTTP とファイル保存だけを差し替える。
セーブはファイルではなく JSON 文字列で返し、ブラウザ側（localStorage）が保存する。
"""
import json

from mrpg.battle import ActionError
from mrpg.game import Game
from web_server import Session, dex_payload, make_out, state_payload, web_text  # noqa: F401


class LocalSession(Session):
    """1 ブラウザで 1 つのゲーム。ログは取らない（端末に残すのはセーブだけ）"""

    def __init__(self, save_json=None):
        self.slot = None
        self.logger = None
        self.game = None
        self.loaded = False
        if save_json:
            try:
                self.game = Game.from_dict(json.loads(save_json))
                self.loaded = True
            except Exception:  # 壊れたセーブは新規で始め直す（元データはブラウザ側に退避済み）
                self.game = None
        if self.game is None:
            self.game = Game("normal")

    def handle(self, req):
        try:
            msgs = self.dispatch(req)
            err = None
        except ActionError as e:
            msgs, err = [], str(e)
        return make_out(self.game, req, msgs, err)

    def save_json(self):
        return json.dumps(self.game.to_dict(), ensure_ascii=False)


SESSION = None


def start(save_json=None):
    global SESSION
    SESSION = LocalSession(save_json or None)
    return SESSION.loaded


def act(req_json):
    req = json.loads(req_json)
    if not isinstance(req, dict):
        req = {}
    out = SESSION.handle(req)
    save = None if req.get("op") == "state" else SESSION.save_json()
    return json.dumps({"out": out, "save": save}, ensure_ascii=False)


def dex():
    return json.dumps(dex_payload(SESSION.game.data), ensure_ascii=False)
