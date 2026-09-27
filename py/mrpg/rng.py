"""16bit 乱数。用途別ストリーム（encounter/capture/battle/pickup/misc）を持つ。

通常モード: エリア進入・戦闘開始時に OS エントロピーを混ぜて再シードする（シードはログに残す）。
実験モード: 固定シードのみ。混ぜない。同じ操作列なら同じ結果になる。
"""
import os

STREAMS = ("encounter", "capture", "battle", "pickup", "misc")
_MUL = 0x41C64E6D
_ADD = 0x6073
_MASK = 0xFFFFFFFF


class Rng16:
    def __init__(self, seed):
        self.state = seed & _MASK

    def next16(self):
        self.state = (self.state * _MUL + _ADD) & _MASK
        return self.state >> 16

    def below(self, n):
        """0..n-1"""
        return self.next16() * n >> 16

    def chance65536(self, k):
        """k/65536 の確率で True"""
        return self.next16() < k

    def percent(self, p):
        return self.below(100) < p

    def range(self, lo, hi):
        """lo..hi（両端含む）"""
        return lo + self.below(hi - lo + 1)

    def weighted(self, items):
        """items: [(value, weight)]"""
        total = sum(w for _, w in items)
        r = self.below(total) if total < 65536 else (self.next16() * total >> 16)
        for v, w in items:
            if r < w:
                return v
            r -= w
        return items[-1][0]


class RngHub:
    def __init__(self, mode="normal", seed=None):
        self.mode = mode
        if seed is None:
            seed = int.from_bytes(os.urandom(4), "little")
        self.base_seed = seed & _MASK
        self.streams = {}
        for i, name in enumerate(STREAMS):
            self.streams[name] = Rng16(self.base_seed ^ ((i + 1) * 0x9E3779B1 & _MASK))
        self.seed_log = [{"event": "init", "mode": mode, "seed": self.base_seed}]

    def __getitem__(self, name):
        return self.streams[name]

    def remix(self, reason, names):
        """通常モードでは OS エントロピーを混ぜる。実験モードでは何もしない（記録のみ）。"""
        if self.mode == "experiment":
            return None
        ent = int.from_bytes(os.urandom(4), "little")
        for n in names:
            s = self.streams[n]
            s.state = (s.state ^ ent) & _MASK
        entry = {"event": "remix", "reason": reason, "entropy": ent,
                 "states": {n: self.streams[n].state for n in names}}
        self.seed_log.append(entry)
        if len(self.seed_log) > 200:
            self.seed_log = self.seed_log[:1] + self.seed_log[-150:]
        return entry

    def to_dict(self):
        return {"mode": self.mode, "base_seed": self.base_seed,
                "states": {n: s.state for n, s in self.streams.items()},
                "seed_log": self.seed_log[-50:]}

    @classmethod
    def from_dict(cls, d):
        hub = cls(d["mode"], d["base_seed"])
        for n, st in d["states"].items():
            if n in hub.streams:
                hub.streams[n].state = st
        hub.seed_log = d.get("seed_log", hub.seed_log)
        return hub
