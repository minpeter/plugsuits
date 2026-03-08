export const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

export const HASHLINE_DICT = Array.from({ length: 256 }, (_, i) => {
  const high = Math.floor(i / 16);
  const low = i % 16;
  return `${NIBBLE_STR[high]}${NIBBLE_STR[low]}`;
});

export const HASHLINE_REF_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/;
export const HASHLINE_OUTPUT_PATTERN =
  /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})\|(.*)$/;
