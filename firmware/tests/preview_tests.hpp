#include "live_preview.hpp"
namespace preview_test {
using lueftlotse::preview::SampleMailbox;
using lueftlotse::preview::Session;

Uuid boot() {
  Uuid id;
  unhex("00112233445546778899aabbccddeeff", id.bytes);
  return id;
}
Frames collect(Session &session, SampleMailbox &mailbox) {
  Frames frames;
  do {
    const auto *frame = session.next(mailbox.snapshot());
    CHECK(frame != nullptr);
    const size_t i = frames.count++;
    CHECK(i < 4 && frame->bytes[4] == i);
    frames.items[i] = *frame;
    CHECK(frame->bytes[1] == frames.items[0].bytes[1]);
    CHECK(frame->bytes[2] == frames.items[0].bytes[2]);
    CHECK(frame->bytes[3] == frames.items[0].bytes[3]);
    session.sent(true, mailbox.snapshot());
  } while (frames.count < frames.items[0].bytes[5]);
  return frames;
}
Message decode(const Frames &frames, Type type) {
  Assembler assembler(type);
  Message message;
  for (size_t i = 0; i < frames.count; ++i)
    CHECK(assembler.push(frames.items[i].bytes, frames.items[i].size, i, message) ==
          (i + 1 == frames.count ? Result::complete : Result::incomplete));
  return message;
}
void handshake(Session &session, SampleMailbox &mailbox) {
  session.connect(boot());
  session.subscribe(true);
  CHECK(session.queue_status(0));
  const auto status = decode(collect(session, mailbox), Type::status);
  CHECK(status.message_id == 0 && status.status.request_id == 0);
  CHECK(eq(status.status.boot_id.bytes, 16, "00112233445546778899aabbccddeeff"));
  CHECK(status.status.latest == 0 && status.status.oldest == 0);
  CHECK(status.status.time_valid == 0 && status.status.storage_state == 0);
  CHECK(session.ready());
}
void test_mailbox() {
  SampleMailbox mailbox;
  CHECK(!mailbox.snapshot().valid && mailbox.snapshot().sample_counter == 0);
  CHECK(mailbox.publish(650, 5));
  CHECK(mailbox.publish(720, 10)); // Overwrite, not a growing sample queue.
  auto sample = mailbox.snapshot();
  CHECK(sample.sample_counter == 2 && sample.ppm == 720 && sample.uptime_ms == 10);
  CHECK(!mailbox.publish(0, 15));
  CHECK(!mailbox.snapshot().valid && mailbox.snapshot().sample_counter == 2);
  CHECK(mailbox.snapshot().invalid_through == 2);
  CHECK(!mailbox.publish(100001, 20));
  CHECK(mailbox.publish(730, 25));
  sample = mailbox.snapshot();
  CHECK(sample.valid && sample.sample_counter == 3 && sample.invalid_through == 2);
  mailbox.invalidate(); // I2C/CRC failures use the same invalidation path.
  mailbox.invalidate();
  CHECK(mailbox.snapshot().sample_counter == 3 && !mailbox.snapshot().valid);
  SampleMailbox limit(UINT64_MAX - 1);
  CHECK(limit.publish(700, 0));
  CHECK(limit.snapshot().sample_counter == UINT64_MAX);
  CHECK(!limit.publish(701, 1));
  CHECK(limit.snapshot().exhausted && !limit.snapshot().valid);
  CHECK(limit.snapshot().invalid_through == UINT64_MAX);
  CHECK(!limit.publish(702, 2));
  CHECK(limit.snapshot().sample_counter == UINT64_MAX);
}
void test_gates_and_reconnect() {
  SampleMailbox mailbox;
  Session session;
  CHECK(mailbox.publish(650, 5));
  CHECK(!session.queue_status(0) && !session.next(mailbox.snapshot()));
  session.connect(boot());
  CHECK(!session.queue_status(0) && !session.next(mailbox.snapshot()));
  session.subscribe(true);
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(!session.queue_status(UINT16_MAX));
  CHECK(session.queue_status(1));
  for (int i = 0; i < 4; ++i) {
    CHECK(!session.ready());
    const auto *frame = session.next(mailbox.snapshot());
    CHECK(frame && frame->bytes[1] == 0x80 && frame->bytes[4] == i);
    if (i == 3) CHECK(mailbox.publish(660, 10)); // Acquired during handshake.
    session.sent(true, mailbox.snapshot());
  }
  CHECK(session.ready() && !session.next(mailbox.snapshot()));
  CHECK(mailbox.publish(670, 15));
  auto live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.sample_counter == 3 && live.live_sample.ppm == 670);
  CHECK(live.live_sample.uptime_ms == 15 && live.message_id == 1);
  CHECK(eq(live.live_sample.boot_id.bytes, 16, "00112233445546778899aabbccddeeff"));
  for (int i = 0; i < 10; ++i) CHECK(!session.next(mailbox.snapshot()));

  session.disconnect();
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(mailbox.publish(680, 20)); // No phone: counter still advances.
  handshake(session, mailbox);
  CHECK(!session.next(mailbox.snapshot())); // No pre-reconnect replay.
  CHECK(mailbox.publish(690, 25));
  live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.sample_counter == 5 && live.message_id == 1);

  session.subscribe(false);
  CHECK(!session.ready() && !session.needs_disconnect());
  CHECK(mailbox.publish(700, 30));
  CHECK(!session.queue_status(2));
  session.subscribe(true);
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(session.queue_status(2));
  CHECK(decode(collect(session, mailbox), Type::status).message_id == 2);
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(mailbox.publish(710, 35));
  live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.message_id == 3 && live.live_sample.sample_counter == 7);
  session.subscribe(true); // Duplicate CCCD enable must not reset readiness.
  CHECK(session.ready() && !session.next(mailbox.snapshot()));
  SampleMailbox rebooted;
  CHECK(rebooted.publish(650, 0) && rebooted.snapshot().sample_counter == 1);
}
void test_priority_and_immutable_packet() {
  SampleMailbox mailbox;
  Session session;
  handshake(session, mailbox);
  CHECK(mailbox.publish(650, 5));
  for (uint16_t i = 1; i <= 4; ++i) CHECK(session.queue_status(i));
  CHECK(!session.queue_status(5)); // Bounded Control queue.
  for (uint16_t i = 1; i <= 4; ++i) {
    const auto status = decode(collect(session, mailbox), Type::status);
    CHECK(status.status.request_id == i && status.message_id == i);
    CHECK(mailbox.publish(650 + i, 5 + i));
  }
  auto live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.sample_counter == 5 && live.live_sample.ppm == 654);
  CHECK(live.message_id == 5 && !session.next(mailbox.snapshot()));

  CHECK(mailbox.publish(700, 20));
  Frames packet;
  packet.count = 3;
  packet.items[0] = *session.next(mailbox.snapshot());
  session.sent(true, mailbox.snapshot());
  CHECK(session.queue_status(6)); // Wait for the current LIVE packet boundary.
  CHECK(mailbox.publish(800, 25));
  for (int i = 1; i < 3; ++i) {
    const auto *frame = session.next(mailbox.snapshot());
    CHECK(frame && frame->bytes[1] == 0x8a && frame->bytes[4] == i);
    packet.items[i] = *frame;
    session.sent(true, mailbox.snapshot());
  }
  live = decode(packet, Type::live_sample);
  CHECK(live.live_sample.ppm == 700 && live.live_sample.sample_counter == 6);
  CHECK(decode(collect(session, mailbox), Type::status).status.request_id == 6);
  live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.ppm == 800 && live.live_sample.sample_counter == 7);
  CHECK(!session.next(mailbox.snapshot()));
}
void test_invalidation_and_partial_failure() {
  SampleMailbox mailbox;
  Session session;
  handshake(session, mailbox);
  CHECK(mailbox.publish(650, 5));
  CHECK(session.queue_status(1));
  mailbox.invalidate();
  collect(session, mailbox);
  CHECK(!session.next(mailbox.snapshot()) && !session.needs_disconnect());
  CHECK(mailbox.publish(660, 10));
  CHECK(session.next(mailbox.snapshot())); // Prepared, not yet handed to ATT.
  mailbox.invalidate();
  CHECK(!session.next(mailbox.snapshot()) && !session.needs_disconnect());
  CHECK(mailbox.publish(670, 15));
  auto live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.sample_counter == 3);
  CHECK(live.message_id == 3); // Discarded unsent packet still consumed ID 2.

  CHECK(mailbox.publish(680, 20));
  CHECK(session.next(mailbox.snapshot()));
  session.sent(true, mailbox.snapshot());
  mailbox.invalidate();
  CHECK(mailbox.publish(690, 25)); // Recovery before the host sees the error.
  CHECK(!session.next(mailbox.snapshot()) && session.needs_disconnect());
  CHECK(!session.queue_status(2));
  session.disconnect();
  handshake(session, mailbox);
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(mailbox.publish(700, 30));
  live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.live_sample.sample_counter == 6);

  // A transport failure at ANY STATUS fragment cannot open the live gate.
  for (int fail_at = 0; fail_at < 4; ++fail_at) {
    session.connect(boot());
    session.subscribe(true);
    CHECK(session.queue_status(0));
    for (int i = 0; i <= fail_at; ++i) {
      CHECK(session.next(mailbox.snapshot()));
      session.sent(i != fail_at, mailbox.snapshot());
    }
    CHECK(!session.ready() && session.needs_disconnect());
    session.sent(true, mailbox.snapshot()); // Late/reentrant success cannot revive it.
    CHECK(!session.ready() && !session.next(mailbox.snapshot()));
  }
  for (int kind = 0; kind < 2; ++kind) {
    handshake(session, mailbox);
    if (kind == 0) CHECK(session.queue_status(1));
    else CHECK(mailbox.publish(750, 35));
    CHECK(session.next(mailbox.snapshot()));
    session.sent(true, mailbox.snapshot());
    session.subscribe(false);
    CHECK(session.needs_disconnect() && !session.ready());
    session.subscribe(true);
    CHECK(!session.next(mailbox.snapshot()));
  }
  // Disconnect while mid-packet discards the rest and all queued Control replies.
  handshake(session, mailbox);
  CHECK(mailbox.publish(800, 40));
  CHECK(session.next(mailbox.snapshot()));
  session.sent(true, mailbox.snapshot());
  CHECK(session.queue_status(1));
  session.disconnect();
  handshake(session, mailbox);
  CHECK(!session.next(mailbox.snapshot()));
}
void test_event_exhaustion() {
  SampleMailbox mailbox;
  Session session;
  handshake(session, mailbox); // Events ID 0.
  for (uint32_t id = 1; id < UINT16_MAX; ++id) {
    CHECK(session.queue_status(uint16_t(id)));
    const auto frames = collect(session, mailbox);
    CHECK((uint32_t(frames.items[0].bytes[3]) << 8 | frames.items[0].bytes[2]) == id);
    CHECK(!session.needs_disconnect());
  }
  CHECK(mailbox.publish(650, 5));
  const auto live = decode(collect(session, mailbox), Type::live_sample);
  CHECK(live.message_id == UINT16_MAX && session.needs_disconnect());
  CHECK(!session.next(mailbox.snapshot()) && !session.queue_status(0));
  CHECK(mailbox.publish(660, 10));
  session.disconnect();
  handshake(session, mailbox); // Events reset; sampleCounter survives.
  CHECK(!session.next(mailbox.snapshot()));
  CHECK(mailbox.publish(670, 15));
  const auto next = decode(collect(session, mailbox), Type::live_sample);
  CHECK(next.message_id == 1 && next.live_sample.sample_counter == 3);
}
void run() {
  test_mailbox();
  test_gates_and_reconnect();
  test_priority_and_immutable_packet();
  test_invalidation_and_partial_failure();
  test_event_exhaustion();
  print("PASS: preview mailbox, handshake, priority, disconnect, errors and ID exhaustion\n");
}
} // namespace preview_test
