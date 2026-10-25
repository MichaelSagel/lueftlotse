#include "ble_server.hpp"
#include "ble_protocol.hpp"
#include "live_preview.hpp"
#include "bootloader_random.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

namespace lueftlotse {
namespace {
namespace protocol = ble;
constexpr char tag[] = "ble_server";
constexpr char name[] = "Lueftlotse";
protocol::Info info;
protocol::Uuid boot_id;
protocol::Assembler control(protocol::Type::get_status);
ble_uuid_any_t service_id{}, info_id{}, control_id{}, events_id{};
ble_gatt_chr_def characteristics[4]{};
ble_gatt_svc_def services[2]{};
ble_npl_callout tick{};
uint8_t own_addr_type{};
uint16_t connection = BLE_HS_CONN_HANDLE_NONE;
uint16_t events_handle{};
bool subscribed{}, closing{};
preview::Session tx;
// Boot-lifetime state: never reset on BLE disconnect, resubscribe or host reset.
portMUX_TYPE sample_lock = portMUX_INITIALIZER_UNLOCKED;
preview::SampleMailbox samples;

preview::SampleSnapshot sample_snapshot() {
  portENTER_CRITICAL(&sample_lock);
  const auto snapshot = samples.snapshot();
  portEXIT_CRITICAL(&sample_lock);
  return snapshot;
}

void require_nimble(int rc) {
  if (rc)
    ESP_LOGE(tag, "NimBLE initialization failed: %d", rc);
  ESP_ERROR_CHECK(rc == 0 ? ESP_OK : ESP_FAIL);
}
uint64_t now_ms() { return uint64_t(esp_timer_get_time() / 1000); }
bool valid_uuid(const protocol::Uuid &id) {
  return (id.bytes[6] & 0xf0) == 0x40 && (id.bytes[8] & 0xc0) == 0x80;
}
protocol::Uuid new_uuid() {
  protocol::Uuid id;
  esp_fill_random(id.bytes, sizeof(id.bytes));
  id.bytes[6] = (id.bytes[6] & 0x0f) | 0x40;
  id.bytes[8] = (id.bytes[8] & 0x3f) | 0x80;
  return id;
}
void load_identity() {
  // Never erase NVS on an init/read error: that would replace device identity.
  ESP_ERROR_CHECK(nvs_flash_init());
  nvs_handle_t handle;
  ESP_ERROR_CHECK(nvs_open("lueftlotse", NVS_READWRITE, &handle));
  size_t size = sizeof(info.device_id.bytes);
  esp_err_t result =
      nvs_get_blob(handle, "device_id", info.device_id.bytes, &size);
  bootloader_random_enable();
  if (result == ESP_ERR_NVS_NOT_FOUND) {
    info.device_id = new_uuid();
    result = nvs_set_blob(handle, "device_id", info.device_id.bytes, size);
    if (result == ESP_OK)
      result = nvs_commit(handle);
  }
  boot_id = new_uuid();
  bootloader_random_disable(); // Must precede NimBLE/RF initialization.
  nvs_close(handle);
  ESP_ERROR_CHECK(result);
  ESP_ERROR_CHECK(size == 16 && valid_uuid(info.device_id)
                      ? ESP_OK
                      : ESP_ERR_INVALID_STATE);
  info.minor = 1;
  info.capabilities = protocol::live_sample_capability;
}
void close_connection() {
  tx.fail();
  if (connection == BLE_HS_CONN_HANDLE_NONE || closing)
    return;
  closing = true;
  int rc = ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
  if (rc != 0) {
    ESP_LOGE(tag, "Disconnect failed: %d; stopping host for safety", rc);
    // Do not continue a session with partial delivery or exhausted IDs.
    ble_hs_sched_reset(rc);
  }
}
int access(uint16_t conn, uint16_t attr, ble_gatt_access_ctxt *ctxt, void *) {
  if (conn != connection || closing)
    return BLE_ATT_ERR_UNLIKELY;
  if (ble_uuid_cmp(ctxt->chr->uuid, &info_id.u) == 0 &&
      ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
    uint8_t bytes[20];
    if (!protocol::encode_info(info, bytes))
      return BLE_ATT_ERR_UNLIKELY;
    return os_mbuf_append(ctxt->om, bytes, sizeof(bytes)) == 0
               ? 0
               : BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  if (ble_uuid_cmp(ctxt->chr->uuid, &control_id.u) != 0 ||
      ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR)
    return BLE_ATT_ERR_REQ_NOT_SUPPORTED;
  const uint16_t length = OS_MBUF_PKTLEN(ctxt->om);
  if (length < 7 || length > 20)
    return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
  uint8_t bytes[20];
  if (os_mbuf_copydata(ctxt->om, 0, length, bytes) != 0)
    return BLE_ATT_ERR_UNLIKELY;
  protocol::Message message;
  const auto result = control.push(bytes, length, now_ms(), message);
  if (result == protocol::Result::incomplete)
    return 0;
  if (result != protocol::Result::complete)
    return BLE_ATT_ERR_VALUE_NOT_ALLOWED;
  // Even rejected commands consume their ID: retry with a fresh messageId.
  if (!subscribed)
    return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
  if (!tx.queue_status(message.message_id)) {
    if (tx.needs_disconnect())
      close_connection();
    return BLE_ATT_ERR_INSUFFICIENT_RES;
  }
  // ATT response only accepts the command. Host timer sends the separate
  // STATUS.
  (void)attr;
  return 0;
}
void on_tick(ble_npl_event *) {
  if (control.expire(now_ms()))
    ESP_LOGW(tag, "Control fragment assembly expired");
  if (connection != BLE_HS_CONN_HANDLE_NONE && subscribed && !closing) {
    const auto *frame = tx.next(sample_snapshot());
    if (frame) {
      os_mbuf *buffer = ble_hs_mbuf_from_flat(frame->bytes, frame->size);
      if (!buffer) {
        ESP_LOGE(tag, "No notification buffer");
        close_connection();
      } else {
        // Consumes buffer even on failure. NOTIFY_TX is called synchronously in
        // this IDF version; an error callback may close the session before return.
        const int rc = ble_gatts_notify_custom(connection, events_handle, buffer);
        if (!closing)
          tx.sent(rc == 0, sample_snapshot());
        if (rc)
          ESP_LOGE(tag, "Notification failed: %d", rc);
      }
    }
    if (tx.needs_disconnect())
      close_connection();
  }
  require_nimble(ble_npl_callout_reset(&tick, ble_npl_time_ms_to_ticks32(50)));
}
int gap_event(ble_gap_event *, void *);
void advertise() {
  if (connection != BLE_HS_CONN_HANDLE_NONE)
    return;
  ble_hs_adv_fields fields{};
  fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
  fields.uuids128 = &service_id.u128;
  fields.num_uuids128 = 1;
  fields.uuids128_is_complete = 1;
  int rc = ble_gap_adv_set_fields(&fields);
  if (rc == 0) {
    // Flags + 128-bit service + complete name exceed legacy advertising's 31
    // bytes. Put the full name into the scan response (active scan).
    ble_hs_adv_fields response{};
    response.name = reinterpret_cast<const uint8_t *>(name);
    response.name_len = sizeof(name) - 1;
    response.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&response);
  }
  if (rc == 0) {
    ble_gap_adv_params params{};
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(own_addr_type, nullptr, BLE_HS_FOREVER, &params,
                           gap_event, nullptr);
  }
  if (rc)
    ESP_LOGE(tag, "Advertising failed: %d", rc);
}
int gap_event(ble_gap_event *event, void *) {
  switch (event->type) {
  case BLE_GAP_EVENT_CONNECT:
    if (event->connect.status != 0) {
      advertise();
      break;
    }
    if (connection != BLE_HS_CONN_HANDLE_NONE) {
      require_nimble(ble_gap_terminate(event->connect.conn_handle,
                                       BLE_ERR_REM_USER_CONN_TERM));
      break;
    }
    connection = event->connect.conn_handle;
    subscribed = false;
    closing = false;
    tx.connect(boot_id);
    control.reset_connection();
    ESP_LOGI(tag, "Connected");
    // No advertising while connected; Kconfig limits host connections to one.
    break;
  case BLE_GAP_EVENT_DISCONNECT:
    if (event->disconnect.conn.conn_handle != connection)
      break;
    tx.disconnect();
    subscribed = false;
    closing = false;
    connection = BLE_HS_CONN_HANDLE_NONE;
    ESP_LOGI(tag, "Disconnected");
    advertise();
    break;
  case BLE_GAP_EVENT_SUBSCRIBE:
    if (event->subscribe.conn_handle == connection &&
        event->subscribe.attr_handle == events_handle) {
      subscribed = event->subscribe.cur_notify != 0;
      tx.subscribe(subscribed);
      if (tx.needs_disconnect())
        close_connection();
    }
    break;
  case BLE_GAP_EVENT_NOTIFY_TX:
    if (event->notify_tx.conn_handle == connection &&
        event->notify_tx.attr_handle == events_handle &&
        !event->notify_tx.indication && event->notify_tx.status != 0) {
      ESP_LOGE(tag, "Notification completion failed: %d",
               event->notify_tx.status);
      close_connection();
    }
    break;
  case BLE_GAP_EVENT_TERM_FAILURE:
    if (event->term_failure.conn_handle == connection) {
      ESP_LOGE(tag, "Connection termination failed: %d",
               event->term_failure.status);
      ble_hs_sched_reset(event->term_failure.status);
    }
    break;
  case BLE_GAP_EVENT_ADV_COMPLETE:
    advertise();
    break;
  default:
    break;
  }
  return 0;
}
void on_reset(int reason) {
  ESP_LOGE(tag, "NimBLE host reset: %d", reason);
  tx.disconnect();
  connection = BLE_HS_CONN_HANDLE_NONE;
  subscribed = false;
  closing = false;
  ble_npl_callout_stop(&tick);
}
void on_sync() {
  require_nimble(ble_hs_util_ensure_addr(0));
  require_nimble(ble_hs_id_infer_auto(0, &own_addr_type));
  require_nimble(ble_npl_callout_reset(&tick, ble_npl_time_ms_to_ticks32(50)));
  advertise();
}
void host_task(void *) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}
} // namespace

bool publish_co2_sample(uint32_t ppm) {
  const uint64_t uptime_ms = now_ms();
  portENTER_CRITICAL(&sample_lock);
  const bool accepted = samples.publish(ppm, uptime_ms);
  portEXIT_CRITICAL(&sample_lock);
  return accepted;
}
void invalidate_co2_sample() {
  portENTER_CRITICAL(&sample_lock);
  samples.invalidate();
  portEXIT_CRITICAL(&sample_lock);
}

void start_ble_server() {
  load_identity();
  ESP_ERROR_CHECK(nimble_port_init());
  require_nimble(ble_uuid_from_str(&service_id, protocol::service_uuid));
  require_nimble(ble_uuid_from_str(&info_id, protocol::info_uuid));
  require_nimble(ble_uuid_from_str(&control_id, protocol::control_uuid));
  require_nimble(ble_uuid_from_str(&events_id, protocol::events_uuid));
  ble_svc_gap_init();
  ble_svc_gatt_init();
  characteristics[0].uuid = &info_id.u;
  characteristics[0].access_cb = access;
  characteristics[0].flags = BLE_GATT_CHR_F_READ;
  characteristics[1].uuid = &control_id.u;
  characteristics[1].access_cb = access;
  characteristics[1].flags = BLE_GATT_CHR_F_WRITE;
  characteristics[2].uuid = &events_id.u;
  characteristics[2].access_cb = access;
  characteristics[2].flags = BLE_GATT_CHR_F_NOTIFY;
  characteristics[2].val_handle = &events_handle;
  services[0].type = BLE_GATT_SVC_TYPE_PRIMARY;
  services[0].uuid = &service_id.u;
  services[0].characteristics = characteristics;
  require_nimble(ble_gatts_count_cfg(services));
  require_nimble(ble_gatts_add_svcs(services));
  require_nimble(ble_svc_gap_device_name_set(name));
  ble_hs_cfg.sync_cb = on_sync;
  ble_hs_cfg.reset_cb = on_reset;
  require_nimble(ble_npl_callout_init(&tick, nimble_port_get_dflt_eventq(),
                                      on_tick, nullptr));
  nimble_port_freertos_init(host_task);
}
} // namespace lueftlotse
