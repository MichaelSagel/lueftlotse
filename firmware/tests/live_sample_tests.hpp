// Included by the freestanding harness after CHECK/unhex/eq.
struct InfoVector {
  uint8_t minor;
  uint16_t capabilities;
  const char *wire;
};
struct LiveSampleVector {
  const char *boot_id;
  uint64_t sample_counter, uptime_ms;
  uint32_t ppm;
  uint16_t message_id;
  const char *body, *logical, *frames[3];
};
#include "shared-live-vectors.hpp"

Result receive_live(Assembler &a, const Frames &frames, Message &out) {
  Result result = Result::incomplete;
  for (size_t i = 0; i < frames.count; ++i) {
    result = a.push(frames.items[i].bytes, frames.items[i].size, i, out);
    if (result != Result::incomplete)
      break;
  }
  return result;
}
void replace_live_crc(Frames &frames) {
  uint8_t input[40] = {1, 0x8a, frames.items[0].bytes[2], frames.items[0].bytes[3]};
  for (size_t i = 0; i < 36; ++i)
    input[4 + i] = frames.items[i / 14].bytes[6 + i % 14];
  const uint32_t crc = crc32(input, sizeof(input));
  for (int i = 0; i < 4; ++i)
    frames.items[2].bytes[14 + i] = uint8_t(crc >> (8 * i));
}
void test_live_sample() {
  Info info;
  CHECK(info.minor == 0 && info.capabilities == 0);
  for (const auto &v : shared_info_vectors) {
    uint8_t bytes[20], encoded[20];
    CHECK(unhex(v.wire, bytes) == 20);
    CHECK(decode_info(bytes, 20, info));
    CHECK(info.minor == v.minor && info.capabilities == v.capabilities);
    CHECK(encode_info(info, encoded) && eq(encoded, 20, v.wire));
    CHECK(supports_live_sample(info) == (v.minor == 1 && (v.capabilities & 16) != 0));
  }
  // Exhaustively audit every u16 capability mask against each supported minor.
  for (uint8_t minor = 0; minor <= 1; ++minor) {
    info.minor = minor;
    const uint16_t mask = minor == 0 ? 15 : 31;
    for (uint32_t caps = 0; caps <= UINT16_MAX; ++caps) {
      uint8_t bytes[20];
      unhex(shared_info_vectors[0].wire, bytes);
      bytes[1] = minor;
      bytes[18] = uint8_t(caps);
      bytes[19] = uint8_t(caps >> 8);
      info.capabilities = uint16_t(caps);
      const bool valid = caps <= mask;
      Info decoded;
      CHECK(decode_info(bytes, 20, decoded) == valid);
      CHECK(encode_info(info, bytes) == valid);
      CHECK(supports_live_sample(info) == (valid && minor == 1 && (caps & 16) != 0));
    }
  }
  for (int offset = 0; offset < 2; ++offset) {
    uint8_t bytes[20];
    unhex(shared_info_vectors[4].wire, bytes);
    bytes[offset] = 2;
    CHECK(!decode_info(bytes, 20, info));
  }
  info.minor = 2;
  info.capabilities = 16;
  uint8_t bytes[20]{};
  CHECK(!encode_info(info, bytes));
  CHECK(!supports_live_sample(info));
  unhex(shared_info_vectors[4].wire, bytes);
  for (size_t length = 0; length < 20; ++length)
    CHECK(!decode_info(bytes, length, info));
  CHECK(!decode_info(bytes, 21, info));
  CHECK(!decode_info(nullptr, 20, info));
  for (int offset = 6; offset <= 8; offset += 2) {
    unhex(shared_info_vectors[4].wire, bytes);
    bytes[2 + offset] = 0;
    CHECK(!decode_info(bytes, 20, info));
  }

  Assembler live(Type::live_sample);
  Message message;
  message.type = Type::live_sample;
  Frames good;
  Message out;
  for (const auto &v : shared_live_vectors) {
    unhex(v.boot_id, message.live_sample.boot_id.bytes);
    message.live_sample.sample_counter = v.sample_counter;
    message.live_sample.uptime_ms = v.uptime_ms;
    message.live_sample.ppm = v.ppm;
    message.message_id = v.message_id;
    CHECK(fragment(message, good));
    CHECK(good.count == 3);
    uint8_t logical[40]{};
    size_t offset = 0;
    for (size_t i = 0; i < good.count; ++i) {
      CHECK(good.items[i].size == (i == 2 ? 18u : 20u));
      CHECK(eq(good.items[i].bytes, good.items[i].size, v.frames[i]));
      for (size_t j = 6; j < good.items[i].size; ++j)
        logical[offset++] = good.items[i].bytes[j];
    }
    CHECK(offset == 40 && eq(logical, 36, v.body) && eq(logical, 40, v.logical));
    // Decode literal shared frames, independently of the encoder's output.
    for (size_t i = 0; i < good.count; ++i)
      good.items[i].size = unhex(v.frames[i], good.items[i].bytes);
    live.reset_connection();
    CHECK(receive_live(live, good, out) == Result::complete);
    CHECK(out.type == Type::live_sample && out.message_id == v.message_id);
    CHECK(eq(out.live_sample.boot_id.bytes, 16, v.boot_id));
    CHECK(out.live_sample.sample_counter == v.sample_counter);
    CHECK(out.live_sample.uptime_ms == v.uptime_ms && out.live_sample.ppm == v.ppm);
    CHECK(receive_live(live, good, out) == Result::reused_id);
  }
  // Every body/CRC byte is protected; failed decode must not publish partial data.
  for (size_t offset = 0; offset < 40; ++offset) {
    Frames bad = good;
    bad.items[offset / 14].bytes[6 + offset % 14] ^= 1;
    live.reset_connection();
    out.message_id = 123;
    CHECK(receive_live(live, bad, out) == Result::crc_mismatch);
    CHECK(out.message_id == 123 && !live.assembling());
  }
  Frames bad = good;
  for (size_t i = 0; i < bad.count; ++i) bad.items[i].bytes[2] ^= 1;
  live.reset_connection();
  CHECK(receive_live(live, bad, out) == Result::crc_mismatch);
  // Invalid UUID version/variant, zero counter and invalid ppm, with VALID CRC.
  for (int field = 0; field < 5; ++field) {
    bad = good;
    if (field < 2) bad.items[0].bytes[6 + (field == 0 ? 6 : 8)] = 0;
    else {
      const size_t start = field == 2 ? 16 : 32;
      const size_t end = field == 2 ? 24 : 36;
      for (size_t offset = start; offset < end; ++offset)
        bad.items[offset / 14].bytes[6 + offset % 14] = field == 4 ? 0xff : 0;
    }
    replace_live_crc(bad);
    live.reset_connection();
    out.message_id = 123;
    CHECK(receive_live(live, bad, out) == Result::invalid);
    CHECK(out.message_id == 123);
  }
  for (int field = 0; field < 5; ++field) {
    Message invalid = message;
    if (field < 2) invalid.live_sample.boot_id.bytes[field == 0 ? 6 : 8] = 0;
    if (field == 2) invalid.live_sample.sample_counter = 0;
    if (field >= 3) invalid.live_sample.ppm = field == 3 ? 0 : 100001;
    Frames unused;
    CHECK(!fragment(invalid, unused) && unused.count == 0);
  }
  // Exact frame lengths: 20, 20, 18. No truncation or extra trailing byte.
  for (size_t index = 0; index < 3; ++index) {
    for (int delta = -1; delta <= 1; delta += 2) {
      bad = good;
      bad.items[index].size += delta;
      live.reset_connection();
      const Result result = receive_live(live, bad, out);
      CHECK(result == (bad.items[index].size > 20 ? Result::invalid : Result::fragment_error));
    }
  }
  for (uint8_t count = 0; count <= 10; ++count) {
    if (count == 3) continue;
    bad = good;
    bad.items[0].bytes[5] = count;
    live.reset_connection();
    CHECK(receive_live(live, bad, out) == Result::fragment_error);
  }
  live.reset_connection();
  CHECK(live.push(good.items[1].bytes, 20, 0, out) == Result::fragment_error);
  for (int next = 0; next <= 2; next += 2) {
    live.reset_connection();
    CHECK(live.push(good.items[0].bytes, 20, 0, out) == Result::incomplete);
    CHECK(live.push(good.items[next].bytes, good.items[next].size, 1, out) == Result::fragment_error);
  }
  live.reset_connection();
  CHECK(live.push(good.items[0].bytes, 20, 0, out) == Result::incomplete);
  CHECK(live.push(good.items[1].bytes, 20, 4999, out) == Result::incomplete);
  CHECK(live.push(good.items[2].bytes, 18, 5000, out) == Result::timeout);
  CHECK(live.push(good.items[0].bytes, 20, 5001, out) == Result::reused_id);
  for (int field = 0; field < 2; ++field) {
    bad = good;
    bad.items[0].bytes[field] = field == 0 ? 2 : 0x86;
    live.reset_connection();
    CHECK(receive_live(live, bad, out) == Result::invalid);
  }
  Assembler control(Type::get_status);
  CHECK(receive_live(control, good, out) == Result::invalid);
}
