#pragma once
#include <stddef.h>
#include <stdint.h>

namespace lueftlotse::ble {
inline constexpr char service_uuid[] = "9c6b1000-7a3e-4d9f-8b52-6e210f42a001";
inline constexpr char info_uuid[] = "9c6b1001-7a3e-4d9f-8b52-6e210f42a001";
inline constexpr char control_uuid[] = "9c6b1002-7a3e-4d9f-8b52-6e210f42a001";
inline constexpr char events_uuid[] = "9c6b1003-7a3e-4d9f-8b52-6e210f42a001";
inline constexpr uint16_t live_sample_capability = 0x0010;
struct Uuid {
  uint8_t bytes[16]{};
};
struct Info {
  Uuid device_id;
  uint16_t capabilities{};
  uint8_t minor{}; // Default remains v1.0; v1.1 must be selected explicitly.
};
struct Status {
  uint16_t request_id{};
  Uuid boot_id;
  uint64_t oldest{}, latest{}, overwritten_through{};
  uint8_t time_valid{};
  uint64_t first_undated{};
  uint8_t storage_state{};
};
struct LiveSample {
  Uuid boot_id;
  // Starts at one per boot, never resets on reconnect; NOT journal sequence.
  uint64_t sample_counter{}, uptime_ms{};
  uint32_t ppm{};
};
enum class Type : uint8_t { get_status = 1, status = 0x80, live_sample = 0x8a };
enum class Result {
  incomplete,
  complete,
  invalid,
  crc_mismatch,
  fragment_error,
  timeout,
  reused_id
};
struct Message {
  Type type{Type::get_status};
  uint16_t message_id{};
  Status status;
  LiveSample live_sample;
};
struct Frame {
  uint8_t bytes[20]{};
  size_t size{};
};
struct Frames {
  Frame items[4]{};
  size_t count{};
};
bool encode_info(const Info &, uint8_t (&out)[20]);
bool decode_info(const uint8_t *, size_t, Info &);
// Pure capability check for future transports; does not enable publication.
bool supports_live_sample(const Info &);
uint32_t crc32(const uint8_t *, size_t);
// Wire codecs have no negotiated session state. LIVE_SAMPLE users must first
// check supports_live_sample(peer_info); no journal/clock behavior is implied.
bool fragment(const Message &, Frames &);
// One instance per incoming direction and connection. No heap or internal
// timer. Caller supplies monotonic milliseconds and calls expire even without
// incoming data.
class Assembler {
public:
  explicit Assembler(Type expected) : expected_(expected) {}
  Result push(const uint8_t *, size_t, uint64_t now_ms, Message &);
  bool expire(uint64_t now_ms);
  void reset_connection();
  bool assembling() const { return active_; }

private:
  Type expected_;
  uint8_t used_[8192]{}, buffer_[56]{};
  size_t size_{};
  uint16_t id_{};
  uint8_t next_{}, count_{};
  uint64_t started_{};
  bool active_{};
  Result fail(Result r) {
    active_ = false;
    size_ = 0;
    return r;
  }
};
} // namespace lueftlotse::ble
