"""Immutable exact integer minutes [0,1440), encoded one bit per minute."""
from collections.abc import Set


class MinuteSet(Set):
    __slots__ = ('_bits',)

    def __init__(self, values=()):
        bits = 0
        for value in values:
            minute = int(value)
            if value != minute or not 0 <= minute < 1440:
                raise ValueError('MINUTE_SET_DOMAIN')
            bits |= 1 << minute
        object.__setattr__(self, '_bits', bits)

    def __setattr__(self, name, value):
        raise AttributeError('IMMUTABLE_MINUTE_SET')

    @property
    def bits(self):
        return self._bits

    @classmethod
    def from_bits(cls, bits):
        if not isinstance(bits, int) or bits < 0 or bits.bit_length() > 1440:
            raise ValueError('MINUTE_SET_DOMAIN')
        result = cls.__new__(cls)
        object.__setattr__(result, '_bits', bits)
        return result

    @classmethod
    def interval(cls, start, end):
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start <= end <= 1440:
            raise ValueError('MINUTE_SET_INTERVAL')
        return cls.from_bits(((1 << (end-start))-1) << start)

    def __contains__(self, minute):
        try:
            integer = int(minute)
        except (TypeError, ValueError, OverflowError):
            return False
        return minute == integer and 0 <= integer < 1440 and bool(self._bits & (1 << integer))

    def __iter__(self):
        bits = self._bits
        while bits:
            lowest = bits & -bits
            yield lowest.bit_length()-1
            bits ^= lowest

    def __len__(self):
        return self._bits.bit_count()

    def __and__(self, other):
        if isinstance(other, MinuteSet):
            return self.from_bits(self._bits & other.bits)
        return super().__and__(other)

    __rand__ = __and__

    def __sub__(self, other):
        if isinstance(other, MinuteSet):
            return self.from_bits(self._bits & ~other.bits)
        return super().__sub__(other)

    def __or__(self, other):
        if isinstance(other, MinuteSet):
            return self.from_bits(self._bits | other.bits)
        return super().__or__(other)

    __ror__ = __or__
