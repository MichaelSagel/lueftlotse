#include "ble_protocol.hpp"
using namespace lueftlotse::ble;
// Freestanding test harness, QEMU virt only; never linked into the ESP32 app.
extern "C" void *memset(void *p, int v, size_t n) {
  auto b = static_cast<unsigned char *>(p);
  for (size_t i = 0; i < n; ++i)
    b[i] = v;
  return p;
}
extern "C" void *memcpy(void *p, const void *s, size_t n) {
  auto b = static_cast<unsigned char *>(p);
  auto a = static_cast<const unsigned char *>(s);
  for (size_t i = 0; i < n; ++i)
    b[i] = a[i];
  return p;
}
void print(const char *s) {
  auto uart = reinterpret_cast<volatile uint8_t *>(0x10000000);
  while (*s)
    *uart = uint8_t(*s++);
}
[[noreturn]] void finish(bool ok) {
  *reinterpret_cast<volatile uint32_t *>(0x100000) = ok ? 0x5555 : 0x13333;
  for (;;) {
  }
}
void check(bool ok, int line) {
  if (!ok) {
    print("FAIL line ");
    char digits[12];
    int n = 0;
    do {
      digits[n++] = char('0' + line % 10);
      line /= 10;
    } while (line);
    while (n) {
      char s[2] = {digits[--n], 0};
      print(s);
    }
    print("\n");
    finish(false);
  }
}
#define CHECK(x) check((x), __LINE__)
uint8_t nibble(char c) { return c <= '9' ? c - '0' : c - 'a' + 10; }
size_t unhex(const char *s, uint8_t *b) {
  size_t n = 0;
  while (*s) {
    b[n++] = uint8_t(nibble(s[0]) * 16 + nibble(s[1]));
    s += 2;
  }
  return n;
}
bool eq(const uint8_t *b, size_t n, const char *hex) {
  uint8_t expected[56]{};
  size_t size = unhex(hex, expected);
  if (n != size)
    return false;
  for (size_t i = 0; i < n; ++i)
    if (b[i] != expected[i])
      return false;
  return true;
}
extern "C" void run_tests() {
  uint8_t info_bytes[20];
  unhex("010000112233445546778899aabbccddeeff0f00", info_bytes);
  Info info;
  CHECK(decode_info(info_bytes, 20, info));
  CHECK(info.capabilities == 15);
  uint8_t encoded[20];
  CHECK(encode_info(info, encoded));
  CHECK(eq(encoded, 20, "010000112233445546778899aabbccddeeff0f00"));
  for (uint16_t caps = 0; caps <= 15; ++caps) {
    info.capabilities = caps;
    CHECK(encode_info(info, encoded));
    Info decoded;
    CHECK(decode_info(encoded, 20, decoded));
    CHECK(decoded.capabilities == caps);
  }
  info.capabilities = 16;
  CHECK(!encode_info(info, encoded));
  info_bytes[0] = 2;
  CHECK(!decode_info(info_bytes, 20, info));
  info_bytes[0] = 1;
  info_bytes[1] = 1;
  CHECK(!decode_info(info_bytes, 20, info));
  info_bytes[1] = 0;
  info_bytes[8] = 0x16;
  CHECK(!decode_info(info_bytes, 20, info));
  info_bytes[8] = 0x46;
  CHECK(!decode_info(info_bytes, 19, info));
  CHECK(decode_info(info_bytes, 20, info));
  const uint8_t text[] = "123456789";
  CHECK(crc32(text, 9) == 0xcbf43926u);
  CHECK(crc32(text, 0) == 0);
  Message request;
  request.message_id = 0x1234;
  Frames f;
  CHECK(fragment(request, f));
  CHECK(f.count == 1);
  CHECK(eq(f.items[0].bytes, f.items[0].size, "010134120001f150a9d0"));
  Message status;
  status.type = Type::status;
  status.message_id = 7;
  status.status.request_id = 65535;
  status.status.boot_id = info.device_id;
  status.status.oldest = 1;
  status.status.latest = 3;
  status.status.time_valid = 1;
  Frames good;
  CHECK(fragment(status, good));
  CHECK(good.count == 4);
  const char *vectors[4] = {"018007000004ffff00112233445546778899aabb",
                            "018007000104ccddeeff01000000000000000300",
                            "0180070002040000000000000000000000000000",
                            "01800700030401000000000000000000b6f860e2"};
  for (int i = 0; i < 4; ++i)
    CHECK(eq(good.items[i].bytes, good.items[i].size, vectors[i]));
  Assembler events(Type::status);
  Assembler control(Type::get_status);
  Message out;
  CHECK(control.push(f.items[0].bytes, f.items[0].size, 0, out) ==
        Result::complete);
  CHECK(out.message_id == 0x1234);
  CHECK(control.push(f.items[0].bytes, f.items[0].size, 0, out) ==
        Result::reused_id);
  for (int i = 0; i < 4; ++i)
    CHECK(events.push(good.items[i].bytes, good.items[i].size, i, out) ==
          (i == 3 ? Result::complete : Result::incomplete));
  CHECK(out.status.latest == 3 && out.status.request_id == 65535);
  events.reset_connection();
  CHECK(events.push(good.items[0].bytes, 20, 0, out) == Result::incomplete);
  CHECK(events.push(good.items[0].bytes, 20, 1, out) == Result::fragment_error);
  events.reset_connection();
  CHECK(events.push(good.items[1].bytes, 20, 0, out) == Result::fragment_error);
  CHECK(events.push(good.items[0].bytes, 20, 0, out) == Result::incomplete);
  CHECK(events.push(good.items[2].bytes, 20, 1, out) == Result::fragment_error);
  events.reset_connection();
  CHECK(events.push(good.items[0].bytes, 20, 0, out) == Result::incomplete);
  CHECK(!events.expire(4999));
  CHECK(events.expire(5000));
  CHECK(!events.assembling());
  CHECK(events.push(good.items[0].bytes, 20, 5001, out) == Result::reused_id);
  for (int offset = 0; offset < 4; ++offset) {
    events.reset_connection();
    Frames bad = good;
    bad.items[3].bytes[16 + offset] ^= 1;
    for (int i = 0; i < 4; ++i)
      CHECK(events.push(bad.items[i].bytes, bad.items[i].size, i, out) ==
            (i == 3 ? Result::crc_mismatch : Result::incomplete));
  }
  events.reset_connection();
  Frames bad = good;
  bad.items[0].bytes[5] = 5;
  CHECK(events.push(bad.items[0].bytes, 20, 0, out) == Result::fragment_error);
  bad = good;
  bad.items[0].bytes[0] = 2;
  CHECK(events.push(bad.items[0].bytes, 20, 0, out) == Result::invalid);
  events.reset_connection();
  CHECK(events.push(good.items[0].bytes, 19, 0, out) == Result::fragment_error);
  // Invalid flags must be rejected even with a valid message CRC.
  for (int flag_offset = 0; flag_offset < 2; ++flag_offset) {
    Frames invalid = good;
    invalid.items[3].bytes[flag_offset == 0 ? 6 : 15] = 2;
    uint8_t crc_input[56] = {1, 0x80, 7, 0};
    for (int i = 0; i < 52; ++i)
      crc_input[4 + i] = invalid.items[i / 14].bytes[6 + i % 14];
    uint32_t checksum = crc32(crc_input, 56);
    for (int i = 0; i < 4; ++i)
      invalid.items[3].bytes[16 + i] = uint8_t(checksum >> (8 * i));
    events.reset_connection();
    out.message_id = 123;
    for (int i = 0; i < 4; ++i)
      CHECK(events.push(invalid.items[i].bytes, 20, i, out) ==
            (i == 3 ? Result::invalid : Result::incomplete));
    CHECK(out.message_id == 123);
    CHECK(!events.assembling());
  }
  events.reset_connection();
  CHECK(events.push(good.items[0].bytes, 20, 10, out) == Result::incomplete);
  CHECK(events.push(good.items[1].bytes, 20, 5010, out) == Result::timeout);
  CHECK(!events.assembling());
  CHECK(events.push(good.items[0].bytes, 21, 5011, out) == Result::invalid);
  // Decode the full uint64 range, not just round-trip small values.
  status.status.oldest = UINT64_MAX;
  status.status.latest = UINT64_MAX;
  status.status.first_undated = UINT64_MAX;
  status.message_id = 65535;
  CHECK(fragment(status, f));
  events.reset_connection();
  for (size_t i = 0; i < f.count; ++i)
    CHECK(events.push(f.items[i].bytes, f.items[i].size, i, out) ==
          (i + 1 == f.count ? Result::complete : Result::incomplete));
  CHECK(out.status.latest == UINT64_MAX &&
        out.status.first_undated == UINT64_MAX);
  status.status.time_valid = 2;
  CHECK(!fragment(status, f));
  status.status.time_valid = 1;
  status.status.storage_state = 2;
  CHECK(!fragment(status, f));
  status.status.storage_state = 0;
  status.status.oldest = 0;
  CHECK(!fragment(status, f));
  request.message_id = 65535;
  CHECK(!fragment(request, f));
  // Independent namespaces accept the same ID.
  request.message_id = 7;
  CHECK(fragment(request, f));
  control.reset_connection();
  CHECK(control.push(f.items[0].bytes, f.items[0].size, 0, out) ==
        Result::complete);
  // ID exhaustion cannot wrap; reset is only for a new connection.
  for (uint32_t id = 0; id < 65535; ++id) {
    if (id == 7)
      continue;
    request.message_id = uint16_t(id);
    CHECK(fragment(request, f));
    CHECK(control.push(f.items[0].bytes, f.items[0].size, 0, out) ==
          Result::complete);
  }
  request.message_id = 0;
  CHECK(fragment(request, f));
  CHECK(control.push(f.items[0].bytes, f.items[0].size, 0, out) ==
        Result::reused_id);
  print("PASS: BLE v1 Info/GET_STATUS/STATUS vectors, CRC, fragments, limits "
        "and IDs\n");
  finish(true);
}