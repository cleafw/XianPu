function vlq(value: number) {
  const bytes = [value & 127]
  for (value >>= 7; value; value >>= 7) bytes.unshift(128 | (value & 127))
  return bytes
}

export const event = (delta: number, ...bytes: number[]) => [...vlq(delta), ...bytes]
export const endTrack = (delta = 0) => event(delta, 0xff, 0x2f, 0)

export function midiFile(format: number, tracks: number[][], ppq = 480) {
  const header = Buffer.alloc(14)
  header.write('MThd')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(format, 8)
  header.writeUInt16BE(tracks.length, 10)
  header.writeUInt16BE(ppq, 12)
  return Buffer.concat([header, ...tracks.map((bytes) => {
    const chunk = Buffer.alloc(8)
    chunk.write('MTrk')
    chunk.writeUInt32BE(bytes.length, 4)
    return Buffer.concat([chunk, Buffer.from(bytes)])
  })])
}

export const ensembleMidi = () => midiFile(1, [
  [
    ...event(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20), // 120 BPM
    ...event(0, 0xff, 0x59, 2, 0xfe, 1), // two flats, minor
    ...event(960, 0xff, 0x58, 4, 3, 3, 24, 8), // 3/8, mid-measure
    ...event(960, 0xff, 0x51, 3, 0x09, 0x27, 0xc0), // 100 BPM, on the next bar
    ...event(0, 0xff, 0x59, 2, 2, 0),
    ...endTrack(),
  ],
  [
    ...event(0, 0x90, 60, 90), ...event(3, 64, 90), ...event(3, 67, 90),
    ...event(474, 72, 90), ...event(480, 72, 0),
    ...event(131, 74, 90), ...event(1, 74, 0),
    ...event(1308, 60, 0), ...event(5, 64, 0), ...event(2, 67, 0),
    ...event(1, 60, 90), ...event(472, 60, 0), ...endTrack(),
  ],
  [
    ...event(0, 0xc0, 24), ...event(0, 0x90, 76, 80),
    ...event(480, 84, 80), ...event(480, 84, 0), ...event(480, 76, 0), ...endTrack(),
  ],
])
