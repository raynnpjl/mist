interface Dimensions { width: number; height: number }
export interface CodecHeader extends Dimensions {
  videoCodec: "h264";
  audioCodec?: "aac";
  channelLayout?: "stereo";
  complete: boolean;
}

class Bits {
  private position = 0;
  constructor(private bytes: Uint8Array) {}

  read(count: number): number {
    if (this.position + count > this.bytes.length * 8) throw new Error("Truncated AVC parameter set");
    let result = 0;
    while (count-- > 0) {
      result = result * 2 + ((this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return result;
  }

  ue(): number {
    let zeros = 0;
    while (!this.read(1)) if (++zeros > 31) throw new Error("Invalid Exp-Golomb code");
    return 2 ** zeros - 1 + this.read(zeros);
  }

  se(): number {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -value / 2;
  }

  moreData(): boolean {
    const position = this.position;
    const more = !this.trailing();
    this.position = position;
    return more;
  }

  trailing(): boolean {
    const remaining = this.bytes.length * 8 - this.position;
    return remaining > 0 && remaining <= 8 && this.read(remaining) === 2 ** (remaining - 1);
  }
}

function rbsp(nal: Buffer): Bits {
  if (nal.length < 2 || nal[0] & 0x80) throw new Error("Invalid AVC NAL unit");
  const bytes: number[] = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const byte = nal[i];
    if (zeros >= 2 && byte <= 3) {
      if (byte !== 3 || i + 1 >= nal.length || nal[i + 1] > 3) throw new Error("Invalid AVC escaping");
      zeros = 0;
      continue;
    }
    bytes.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Bits(Uint8Array.from(bytes));
}

function skipVui(bits: Bits) {
  if (bits.read(1) && bits.read(8) === 255) bits.read(32);
  if (bits.read(1)) bits.read(1);
  if (bits.read(1)) {
    bits.read(4);
    if (bits.read(1)) bits.read(24);
  }
  if (bits.read(1)) { bits.ue(); bits.ue(); }
  if (bits.read(1)) { bits.read(32); bits.read(32); bits.read(1); }
  const skipHrd = () => {
    const count = bits.ue() + 1;
    if (count > 32) throw new Error("Invalid AVC HRD count");
    bits.read(8);
    for (let i = 0; i < count; i++) { bits.ue(); bits.ue(); bits.read(1); }
    bits.read(20);
  };
  const nalHrd = bits.read(1);
  if (nalHrd) skipHrd();
  const vclHrd = bits.read(1);
  if (vclHrd) skipHrd();
  if (nalHrd || vclHrd) bits.read(1);
  bits.read(1);
  if (bits.read(1)) {
    bits.read(1);
    for (let i = 0; i < 6; i++) bits.ue();
  }
}

function skipScaling(bits: Bits, count: number) {
  for (let i = 0; i < count; i++) {
    if (!bits.read(1)) continue;
    let previous = 8, next = 8;
    for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
      if (next) next = (previous + bits.se() + 256) & 255;
      previous = next || previous;
    }
  }
}

function avcSps(nal: Buffer): Dimensions & { id: number; chroma: number } {
  const bits = rbsp(nal);
  const profile = bits.read(8), constraints = bits.read(8), level = bits.read(8), id = bits.ue();
  if (constraints & 3 || !level || id > 31) throw new Error("Invalid AVC SPS");
  let chroma = 1, separate = 0;
  if ([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244].includes(profile)) {
    chroma = bits.ue();
    if (chroma > 3) throw new Error("Invalid AVC chroma format");
    if (chroma === 3) separate = bits.read(1);
    if (bits.ue() > 6 || bits.ue() > 6) throw new Error("Invalid AVC bit depth");
    bits.read(1);
    if (bits.read(1)) skipScaling(bits, chroma === 3 ? 12 : 8);
  } else if (![66, 77, 88].includes(profile)) throw new Error("Unsupported AVC profile");
  if (bits.ue() > 12) throw new Error("Invalid AVC frame number");
  const order = bits.ue();
  if (order === 0 && bits.ue() > 12 || order > 2) throw new Error("Invalid AVC picture order");
  if (order === 1) {
    bits.read(1); bits.se(); bits.se();
    const count = bits.ue();
    if (count > 255) throw new Error("Invalid AVC picture order count");
    for (let i = 0; i < count; i++) bits.se();
  }
  bits.ue(); bits.read(1);
  let width = 16 * (bits.ue() + 1), height = 16 * (bits.ue() + 1);
  const frameOnly = bits.read(1);
  height *= 2 - frameOnly;
  if (!frameOnly) bits.read(1);
  bits.read(1);
  if (bits.read(1)) {
    const arrayType = separate ? 0 : chroma;
    const cropX = arrayType === 1 || arrayType === 2 ? 2 : 1;
    const cropY = (arrayType === 1 ? 2 : 1) * (2 - frameOnly);
    width -= (bits.ue() + bits.ue()) * cropX;
    height -= (bits.ue() + bits.ue()) * cropY;
  }
  if (bits.read(1)) skipVui(bits);
  if (!bits.trailing() || width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error("Invalid AVC dimensions");
  return { width, height, id, chroma };
}

function avcPps(nal: Buffer, sps: Map<number, ReturnType<typeof avcSps>>) {
  const bits = rbsp(nal), id = bits.ue(), ref = bits.ue();
  if (id > 255 || !sps.has(ref)) throw new Error("Invalid AVC PPS");
  bits.read(2);
  if (bits.ue() !== 0) throw new Error("Unsupported AVC slice groups");
  if (bits.ue() > 31 || bits.ue() > 31) throw new Error("Invalid AVC reference count");
  bits.read(3);
  bits.se(); bits.se(); bits.se(); bits.read(3);
  if (bits.moreData()) {
    const transform8x8 = bits.read(1);
    if (bits.read(1)) skipScaling(bits, 6 + transform8x8 * (sps.get(ref)!.chroma === 3 ? 6 : 2));
    bits.se();
  }
  if (!bits.trailing()) throw new Error("Invalid AVC PPS");
  return { id, ref };
}

interface Packet { pid: number; start: boolean; counter: number; data: Buffer }

function packets(sample: Buffer): Packet[] {
  const output: Packet[] = [];
  for (let i = 0; i + 188 <= sample.length; i += 188) {
    const packet = sample.subarray(i, i + 188);
    const control = (packet[3] >> 4) & 3;
    if (packet[0] !== 0x47 || packet[1] & 0x80 || packet[3] & 0xc0 || !control) throw new Error("Invalid MPEG-TS packet");
    if (!(control & 1)) continue;
    const offset = control === 3 ? 5 + packet[4] : 4;
    if (offset >= 188) throw new Error("Invalid MPEG-TS adaptation field");
    output.push({ pid: ((packet[1] & 0x1f) << 8) | packet[2], start: Boolean(packet[1] & 0x40),
      counter: packet[3] & 15, data: packet.subarray(offset) });
  }
  return output;
}

function section(packets: Packet[], pid: number, table: number): Buffer {
  let bytes: Buffer = Buffer.alloc(0), counter = -1;
  for (const packet of packets) {
    if (packet.pid !== pid) continue;
    if (packet.start) {
      const start = packet.data[0] + 1;
      if (start >= packet.data.length) continue;
      bytes = packet.data.subarray(start);
    } else {
      if (!bytes.length || packet.counter !== (counter + 1) % 16) { bytes = Buffer.alloc(0); continue; }
      bytes = Buffer.concat([bytes, packet.data]);
    }
    counter = packet.counter;
    if (bytes.length < 3) continue;
    const length = 3 + ((bytes[1] & 15) << 8) + bytes[2];
    if (bytes[0] !== table || (bytes[1] & 0xf0) !== 0xb0 || length > 1024 || length < 12) throw new Error("Invalid MPEG-TS table");
    if (bytes.length < length) continue;
    const result = bytes.subarray(0, length);
    let crc = 0xffffffff;
    for (const byte of result) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
    }
    if (crc || !(result[5] & 1) || result[6] || result[7]) throw new Error("Invalid MPEG-TS table");
    return result.subarray(0, length - 4);
  }
  throw new Error("Missing MPEG-TS table");
}

function elementary(packets: Packet[], pid: number, streamId: number): Buffer {
  const chunks: Buffer[] = [];
  let counter = -1, remaining = 0;
  for (const packet of packets) {
    if (packet.pid !== pid) continue;
    if (packet.start) {
      const data = packet.data;
      if (data.length < 9 || data.readUIntBE(0, 3) !== 1 || (data[3] & 0xf0) !== streamId || (data[6] & 0xc0) !== 0x80) break;
      const start = 9 + data[8], length = data.readUInt16BE(4);
      if (start > data.length || length && length < start - 6) break;
      remaining = length ? length - (start - 6) : Infinity;
      chunks.push(data.subarray(start, start + remaining));
      remaining -= chunks.at(-1)!.length;
    } else if (chunks.length) {
      if (packet.counter !== (counter + 1) % 16) break;
      chunks.push(packet.data.subarray(0, remaining));
      remaining -= chunks.at(-1)!.length;
    }
    counter = packet.counter;
  }
  return Buffer.concat(chunks);
}

function annexB(bytes: Buffer): Dimensions | undefined {
  const sps = new Map<number, ReturnType<typeof avcSps>>(), pps = new Map<number, number>();
  let start = -1, zeros = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && !bytes[i]) { zeros++; continue; }
    if (i === bytes.length || bytes[i] === 1 && zeros >= 2) {
      const nal = bytes.subarray(start, i - zeros);
      if (start >= 0 && nal.length) {
        const type = nal[0] & 31;
        if (type === 7 && i < bytes.length) {
          const dimensions = avcSps(nal);
          sps.set(dimensions.id, dimensions);
        } else if (type === 8 && i < bytes.length) {
          const { id, ref } = avcPps(nal, sps);
          pps.set(id, ref);
        } else if (type === 5 || type === 1) {
          // Only the slice header is needed. The last packet can end inside this slice.
          const bits = rbsp(nal.subarray(0, Math.min(nal.length, 64)));
          bits.ue();
          if (bits.ue() > 9) return;
          const dimensions = sps.get(pps.get(bits.ue()) ?? -1);
          if (dimensions) return { width: dimensions.width, height: dimensions.height };
        }
      }
      start = i + 1;
    }
    zeros = 0;
  }
}

export function tsCodecHeader(sample: Buffer): CodecHeader | undefined {
  try {
    const transport = packets(sample);
    const pat = section(transport, 0, 0);
    let program = 0, pmtPid = 0;
    if ((pat.length - 8) % 4) return;
    for (let i = 8; i < pat.length; i += 4) {
      const id = pat.readUInt16BE(i);
      if (id === 0) continue;
      if (program) return;
      program = id;
      pmtPid = pat.readUInt16BE(i + 2) & 0x1fff;
    }
    if (!pmtPid) return;
    const pmt = section(transport, pmtPid, 2);
    if (pmt.length < 12 || pmt.readUInt16BE(3) !== program) return;
    const programInfo = pmt.readUInt16BE(10) & 0xfff;
    let video = 0, audio = 0, complete = programInfo === 0;
    for (let i = 12 + programInfo; i < pmt.length;) {
      if (i + 5 > pmt.length) return;
      const type = pmt[i], pid = pmt.readUInt16BE(i + 1) & 0x1fff;
      const end = i + 5 + (pmt.readUInt16BE(i + 3) & 0xfff);
      if (end > pmt.length) return;
      if (type === 0x1b) {
        if (video) return; // The PMT does not identify one of several AVC tracks as primary.
        video = pid;
      } else if (type === 0x0f && !audio) audio = pid;
      else if ([0x01, 0x02, 0x10, 0x1f, 0x20, 0x21, 0x24, 0x27, 0x33, 0x42, 0xd1, 0xea].includes(type)) return;
      else complete = false;
      for (let d = i + 5; d < end;) {
        if (d + 2 > end || d + 2 + pmt[d + 1] > end) return;
        if (type !== 0x0f || pmt[d] !== 0x0a || !pmt[d + 1] || pmt[d + 1] % 4) complete = false;
        d += 2 + pmt[d + 1];
      }
      i = end;
    }
    if (!video) return;
    const dimensions = annexB(elementary(transport, video, 0xe0));
    if (!dimensions) return;
    const adts = audio ? elementary(transport, audio, 0xc0) : Buffer.alloc(0);
    const frameLength = adts.length >= 7 ? ((adts[3] & 3) << 11) | (adts[4] << 3) | (adts[5] >> 5) : 0;
    // AAC-LC with a signalled stereo layout. Other AAC profiles/configurations use FFprobe.
    const stereo = frameLength > 7 && frameLength <= adts.length && adts[0] === 255 && (adts[1] & 0xf6) === 0xf0 &&
      adts[2] >> 6 === 1 && ((adts[2] >> 2) & 15) < 13 && ((adts[2] & 1) << 2 | adts[3] >> 6) === 2;
    return { ...dimensions, videoCodec: "h264", ...(stereo ? { audioCodec: "aac", channelLayout: "stereo" } : {}),
      complete: complete && stereo };
  } catch { return undefined; }
}

function mp4Boxes(bytes: Buffer): { type: string; body: Buffer }[] {
  const result: { type: string; body: Buffer }[] = [];
  for (let position = 0; position < bytes.length;) {
    if (position + 8 > bytes.length) throw new Error("Incomplete MP4 box");
    let header = 8, size = bytes.readUInt32BE(position);
    const type = bytes.toString("ascii", position + 4, position + 8);
    if (size === 1) {
      header = 16;
      size = Number(bytes.readBigUInt64BE(position + 8));
    } else if (!size) size = bytes.length - position;
    if (size < header || size > bytes.length - position) throw new Error("Invalid MP4 box size");
    result.push({ type, body: bytes.subarray(position + header, position + size) });
    position += size;
  }
  return result;
}

export function mp4InitCodecHeader(sample: Buffer): CodecHeader | undefined {
  try {
    const child = (bytes: Buffer, type: string) => {
      const box = mp4Boxes(bytes).find(box => box.type === type);
      if (!box) throw new Error("Missing MP4 box");
      return box.body;
    };
    const video = mp4Boxes(child(sample, "moov")).filter(box => box.type === "trak")
      .map(box => child(box.body, "mdia")).filter(box => child(box, "hdlr").toString("ascii", 8, 12) === "vide");
    if (video.length !== 1) return;
    const stsd = child(child(child(video[0], "minf"), "stbl"), "stsd");
    if (stsd.readUInt32BE(4) !== 1) return;
    const entries = mp4Boxes(stsd.subarray(8));
    if (entries.length !== 1 || entries[0].type !== "avc1") return;
    const config = child(entries[0].body.subarray(78), "avcC");
    if (config.length < 8 || config[0] !== 1 || (config[4] & 0xfc) !== 0xfc || (config[5] & 0xe0) !== 0xe0) return;
    let offset = 6;
    const nal = (type: number) => {
      const length = config.readUInt16BE(offset);
      offset += 2;
      const end = offset + length, result = config.subarray(offset, end);
      if (end > config.length || (result[0] & 31) !== type) throw new Error("Invalid AVC decoder configuration");
      offset = end;
      return result;
    };
    const count = config[5] & 31;
    if (count !== 1) return;
    const sps = avcSps(nal(7));
    const { id, width, height } = sps;
    const ppsCount = config[offset++];
    if (!ppsCount) return;
    const parameterSets = new Map([[id, sps]]);
    for (let i = 0; i < ppsCount; i++) avcPps(nal(8), parameterSets);
    // Keep FFprobe for fragment, audio and subtitle inspection.
    return { width, height, videoCodec: "h264", complete: false };
  } catch { return undefined; }
}
