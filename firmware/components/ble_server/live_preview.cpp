#include "live_preview.hpp"

namespace lueftlotse::preview {
bool SampleMailbox::publish(uint32_t ppm, uint64_t uptime_ms) {
  if (state_.sample_counter == UINT64_MAX) {
    state_.exhausted = true;
    invalidate();
    return false;
  }
  if (ppm == 0 || ppm > 100000) {
    invalidate();
    return false;
  }
  ++state_.sample_counter;
  state_.uptime_ms = uptime_ms;
  state_.ppm = ppm;
  state_.valid = true;
  return true;
}
void SampleMailbox::invalidate() {
  state_.valid = false;
  // Keep this watermark after recovery so even a copied in-flight old sample
  // is invalidated if the host missed the intervening error.
  state_.invalid_through = state_.sample_counter;
}
void Session::clear_active() {
  active_.count = 0;
  next_frame_ = 0;
}
void Session::connect(const ble::Uuid &boot_id) {
  *this = Session{}; // Only a NEW connection resets the Events ID space.
  boot_id_ = boot_id;
  connected_ = true;
}
void Session::disconnect() {
  clear_active();
  request_head_ = request_count_ = 0;
  connected_ = subscribed_ = ready_ = closing_ = false;
}
void Session::fail() {
  clear_active();
  request_head_ = request_count_ = 0;
  ready_ = false;
  closing_ = true;
}
void Session::subscribe(bool enabled) {
  if (!enabled && subscribed_) {
    if (active_.count && next_frame_ > 0)
      fail(); // A partial message cannot be resumed in the same connection.
    else
      clear_active();
    request_head_ = request_count_ = 0;
    ready_ = false; // Resubscribe requires a fresh GET_STATUS/STATUS handshake.
  }
  subscribed_ = enabled;
}
bool Session::queue_status(uint16_t request_id) {
  if (!connected_ || !subscribed_ || closing_ || request_id == UINT16_MAX)
    return false;
  if (next_event_id_ > UINT16_MAX) {
    fail();
    return false;
  }
  if (request_count_ == 4)
    return false;
  requests_[(request_head_ + request_count_) % 4] = request_id;
  ++request_count_;
  return true;
}
const ble::Frame *Session::next(const SampleSnapshot &sample) {
  if (!connected_ || !subscribed_ || closing_)
    return nullptr;
  if (active_.count && active_type_ == ble::Type::live_sample &&
      active_sample_ <= sample.invalid_through) {
    if (next_frame_ > 0) {
      fail();
      return nullptr;
    }
    clear_active(); // Nothing reached ATT yet; discard without reusing its ID.
  }
  if (active_.count)
    return &active_.items[next_frame_];
  if (next_event_id_ > UINT16_MAX) {
    fail();
    return nullptr;
  }
  ble::Message message;
  if (request_count_) {
    message.type = ble::Type::status;
    message.status.request_id = requests_[request_head_];
    message.status.boot_id = boot_id_;
    // Empty journal, unknown time, storage OK; no journal state is invented.
    request_head_ = (request_head_ + 1) % 4;
    --request_count_;
  } else if (ready_ && sample.valid && sample.sample_counter > seen_sample_ &&
             sample.sample_counter > sample.invalid_through) {
    message.type = ble::Type::live_sample;
    message.live_sample.boot_id = boot_id_;
    message.live_sample.sample_counter = sample.sample_counter;
    message.live_sample.uptime_ms = sample.uptime_ms;
    message.live_sample.ppm = sample.ppm;
    seen_sample_ = active_sample_ = sample.sample_counter;
  } else {
    return nullptr;
  }
  message.message_id = uint16_t(next_event_id_++);
  active_type_ = message.type;
  if (!ble::fragment(message, active_)) {
    fail();
    return nullptr;
  }
  return &active_.items[0];
}
void Session::sent(bool success, const SampleSnapshot &sample) {
  // A synchronous NimBLE NOTIFY_TX error callback may already have called fail.
  if (closing_ || !active_.count)
    return;
  if (!success || (active_type_ == ble::Type::live_sample &&
                   active_sample_ <= sample.invalid_through)) {
    fail();
    return;
  }
  if (++next_frame_ != active_.count)
    return;
  if (active_type_ == ble::Type::status && !ready_) {
    ready_ = true;
    // Do not replay a sample from before/during this subscription's handshake.
    seen_sample_ = sample.sample_counter;
  }
  clear_active();
  if (next_event_id_ > UINT16_MAX)
    fail(); // ID 65535 was usable once; reconnect before any further Events.
}
} // namespace lueftlotse::preview
