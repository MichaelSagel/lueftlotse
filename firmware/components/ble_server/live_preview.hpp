#pragma once
#include "ble_protocol.hpp"

namespace lueftlotse::preview {
struct SampleSnapshot {
  uint64_t sample_counter{}, uptime_ms{}, invalid_through{};
  uint32_t ppm{};
  bool valid{}, exhausted{};
};

// One overwrite slot, owned for the entire boot. The ESP adapter holds one
// portMUX critical section for EVERY publish/invalidate/snapshot operation.
// Pure state is separate so the production logic can run in freestanding tests.
class SampleMailbox {
public:
  explicit SampleMailbox(uint64_t initial_counter = 0) {
    state_.sample_counter = initial_counter;
  }
  bool publish(uint32_t ppm, uint64_t uptime_ms);
  void invalidate();
  SampleSnapshot snapshot() const { return state_; }

private:
  SampleSnapshot state_;
};

// NimBLE host task only. Four waiting Control replies plus one active message;
// LIVE_SAMPLE has no FIFO, and never interrupts or interleaves a reply.
class Session {
public:
  void connect(const ble::Uuid &boot_id);
  void disconnect();
  void subscribe(bool enabled);
  bool queue_status(uint16_t request_id);
  const ble::Frame *next(const SampleSnapshot &);
  // Called only after notify_custom returns. Success means local TX acceptance,
  // not an application ACK; any notify failure terminates the whole session.
  void sent(bool success, const SampleSnapshot &);
  void fail();
  bool needs_disconnect() const { return closing_; }
  bool ready() const { return ready_; }

private:
  void clear_active();
  ble::Uuid boot_id_;
  ble::Frames active_;
  ble::Type active_type_{ble::Type::status};
  size_t next_frame_{};
  uint16_t requests_[4]{};
  size_t request_head_{}, request_count_{};
  uint32_t next_event_id_{}; // Can represent 65536; never wraps the wire u16.
  uint64_t seen_sample_{}, active_sample_{};
  bool connected_{}, subscribed_{}, ready_{}, closing_{};
};
} // namespace lueftlotse::preview
