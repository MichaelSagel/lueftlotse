#include "ble_protocol.hpp"
namespace lueftlotse::ble {
namespace {
void copy(uint8_t *dst, const uint8_t *src, size_t n) {
  for (size_t i = 0; i < n; ++i)
    dst[i] = src[i];
}
void put(uint8_t *p, uint64_t v, size_t n) {
  for (size_t i = 0; i < n; ++i)
    p[i] = uint8_t(v >> (i * 8));
}
uint64_t get(const uint8_t *p, size_t n) {
  uint64_t v = 0;
  for (size_t i = 0; i < n; ++i)
    v |= uint64_t(p[i]) << (i * 8);
  return v;
}
bool uuid(const Uuid &u) {
  return (u.bytes[6] & 0xf0) == 0x40 && (u.bytes[8] & 0xc0) == 0x80;
}
bool valid(const Info &i) {
  if (i.minor > 1 || !uuid(i.device_id))
    return false;
  const uint16_t mask = i.minor == 0 ? 0x000f : 0x001f;
  return (i.capabilities & ~mask) == 0;
}
bool valid(const LiveSample &s) {
  return uuid(s.boot_id) && s.sample_counter != 0 && s.ppm >= 1 &&
         s.ppm <= 100000;
}
// Body sizes are wire sizes; never sizeof(C++ structs), which may have padding.
size_t logical_size(Type type) {
  switch (type) {
  case Type::get_status: return 4;
  case Type::status: return 56;
  case Type::live_sample: return 40;
  default: return 0;
  }
}
void write_live_sample(const LiveSample &s, uint8_t *b) {
  copy(b, s.boot_id.bytes, 16);
  put(b + 16, s.sample_counter, 8);
  put(b + 24, s.uptime_ms, 8);
  put(b + 32, s.ppm, 4);
}
LiveSample read_live_sample(const uint8_t *b) {
  LiveSample s;
  copy(s.boot_id.bytes, b, 16);
  s.sample_counter = get(b + 16, 8);
  s.uptime_ms = get(b + 24, 8);
  s.ppm = uint32_t(get(b + 32, 4));
  return s;
}
bool valid(const Status &s) {
  return uuid(s.boot_id) && s.time_valid <= 1 && s.storage_state <= 1 &&
         ((s.oldest == 0 && s.latest == 0) ||
          (s.oldest > 0 && s.oldest <= s.latest)) &&
         s.overwritten_through <= s.latest &&
         (s.overwritten_through == 0 || s.overwritten_through < s.oldest) &&
         (s.first_undated == 0 ||
          (s.first_undated >= s.oldest && s.first_undated <= s.latest));
}
void write_status(const Status &s, uint8_t *b) {
  put(b, s.request_id, 2);
  copy(b + 2, s.boot_id.bytes, 16);
  put(b + 18, s.oldest, 8);
  put(b + 26, s.latest, 8);
  put(b + 34, s.overwritten_through, 8);
  b[42] = s.time_valid;
  put(b + 43, s.first_undated, 8);
  b[51] = s.storage_state;
}
Status read_status(const uint8_t *b) {
  Status s;
  s.request_id = uint16_t(get(b, 2));
  copy(s.boot_id.bytes, b + 2, 16);
  s.oldest = get(b + 18, 8);
  s.latest = get(b + 26, 8);
  s.overwritten_through = get(b + 34, 8);
  s.time_valid = b[42];
  s.first_undated = get(b + 43, 8);
  s.storage_state = b[51];
  return s;
}
uint32_t message_crc(Type type, uint16_t id, const uint8_t *b, size_t n) {
  uint8_t input[56]{};
  input[0] = 1;
  input[1] = uint8_t(type);
  put(input + 2, id, 2);
  copy(input + 4, b, n);
  return crc32(input, n + 4);
}
} // namespace
uint32_t crc32(const uint8_t *p, size_t n) {
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < n; ++i) {
    crc ^= p[i];
    for (int j = 0; j < 8; ++j)
      crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320u : 0u);
  }
  return crc ^ 0xffffffff;
}
bool encode_info(const Info &i, uint8_t (&out)[20]) {
  if (!valid(i))
    return false;
  out[0] = 1;
  out[1] = i.minor;
  copy(out + 2, i.device_id.bytes, 16);
  put(out + 18, i.capabilities, 2);
  return true;
}
bool decode_info(const uint8_t *b, size_t n, Info &out) {
  if (!b || n != 20 || b[0] != 1)
    return false;
  Info i;
  i.minor = b[1];
  copy(i.device_id.bytes, b + 2, 16);
  i.capabilities = uint16_t(get(b + 18, 2));
  if (!valid(i))
    return false;
  out = i;
  return true;
}
bool supports_live_sample(const Info &i) {
  return valid(i) && i.minor == 1 && (i.capabilities & live_sample_capability);
}
bool fragment(const Message &m, Frames &out) {
  out.count = 0;
  const size_t total = logical_size(m.type);
  if (!total)
    return false;
  if ((m.type == Type::get_status && m.message_id == 65535) ||
      (m.type == Type::status && !valid(m.status)) ||
      (m.type == Type::live_sample && !valid(m.live_sample)))
    return false;
  uint8_t b[56]{};
  size_t n = total - 4;
  if (m.type == Type::status)
    write_status(m.status, b);
  else if (m.type == Type::live_sample)
    write_live_sample(m.live_sample, b);
  put(b + n, message_crc(m.type, m.message_id, b, n), 4);
  n += 4;
  out.count = (n + 13) / 14;
  for (size_t i = 0; i < out.count; ++i) {
    Frame &f = out.items[i];
    f.bytes[0] = 1;
    f.bytes[1] = uint8_t(m.type);
    put(f.bytes + 2, m.message_id, 2);
    f.bytes[4] = uint8_t(i);
    f.bytes[5] = uint8_t(out.count);
    size_t len = n - i * 14;
    if (len > 14)
      len = 14;
    copy(f.bytes + 6, b + i * 14, len);
    f.size = len + 6;
  }
  return true;
}
bool Assembler::expire(uint64_t now) {
  if (active_ && (now < started_ || now - started_ >= 5000)) {
    fail(Result::timeout);
    return true;
  }
  return false;
}
void Assembler::reset_connection() {
  for (auto &b : used_)
    b = 0;
  fail(Result::incomplete);
}
Result Assembler::push(const uint8_t *f, size_t n, uint64_t now, Message &out) {
  if (expire(now))
    return Result::timeout;
  if (!f || n < 7 || n > 20 || f[0] != 1 || f[1] != uint8_t(expected_))
    return fail(Result::invalid);
  const auto id = uint16_t(get(f + 2, 2));
  const size_t total = logical_size(expected_);
  if (!total)
    return fail(Result::invalid);
  if (expected_ == Type::get_status && id == 65535)
    return fail(Result::invalid);
  if (!active_) {
    if (f[4] != 0)
      return fail(Result::fragment_error);
    if (used_[id / 8] & (1u << (id % 8)))
      return fail(Result::reused_id);
    used_[id / 8] |= uint8_t(1u << (id % 8));
    active_ = true;
    id_ = id;
    count_ = uint8_t((total + 13) / 14);
    next_ = 0;
    size_ = 0;
    started_ = now;
  }
  size_t len = total - size_;
  if (len > 14)
    len = 14;
  if (id != id_ || f[4] != next_ || f[5] != count_ || n != len + 6)
    return fail(Result::fragment_error);
  copy(buffer_ + size_, f + 6, len);
  size_ += len;
  ++next_;
  if (next_ != count_)
    return Result::incomplete;
  if (get(buffer_ + total - 4, 4) !=
      message_crc(expected_, id_, buffer_, total - 4))
    return fail(Result::crc_mismatch);
  Message m;
  m.type = expected_;
  m.message_id = id_;
  if (expected_ == Type::status) {
    m.status = read_status(buffer_);
    if (!valid(m.status))
      return fail(Result::invalid);
  } else if (expected_ == Type::live_sample) {
    m.live_sample = read_live_sample(buffer_);
    if (!valid(m.live_sample))
      return fail(Result::invalid);
  }
  out = m;
  fail(Result::complete);
  return Result::complete;
}
} // namespace lueftlotse::ble
