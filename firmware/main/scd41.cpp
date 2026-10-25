#include "scd41.hpp"

#include <cstddef>
#include <cstdint>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace lueftlotse {
namespace {
constexpr char tag[] = "scd41";
constexpr int timeout_ms = 100;

// Sensirion SCD4x datasheet: CRC-8, init 0xff, polynomial 0x31,
// no reflection or final XOR. Each two-byte word has its own CRC.
constexpr uint8_t word_crc(uint16_t word) {
  uint8_t crc = 0xff;
  for (int shift = 8; shift >= 0; shift -= 8) {
    crc ^= uint8_t(word >> shift);
    for (int bit = 0; bit < 8; ++bit)
      crc = uint8_t((crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1);
  }
  return crc;
}
static_assert(word_crc(0xbeef) == 0x92); // Datasheet check vector.
static_assert(word_crc(0xf896) == 0x31);
static_assert(word_crc(0x9f07) == 0xc2);
static_assert(word_crc(0x3bbe) == 0x89);

void wait_ms(uint32_t ms) {
  // One extra tick ensures at least the specified command execution time,
  // even when called immediately before a scheduler tick.
  vTaskDelay(pdMS_TO_TICKS(ms) + 1);
}

bool checked(esp_err_t error, const char *operation) {
  if (error == ESP_OK)
    return true;
  ESP_LOGE(tag, "%s: %s (0x%x)", operation, esp_err_to_name(error),
           unsigned(error));
  return false;
}

bool command(i2c_master_dev_handle_t device, uint16_t value) {
  const uint8_t bytes[] = {uint8_t(value >> 8), uint8_t(value)};
  const esp_err_t error =
      i2c_master_transmit(device, bytes, sizeof(bytes), timeout_ms);
  if (error != ESP_OK) {
    ESP_LOGE(tag, "Command 0x%04x: %s (0x%x)", unsigned(value),
             esp_err_to_name(error), unsigned(error));
    return false;
  }
  return true;
}

bool read_words(i2c_master_dev_handle_t device, uint16_t cmd,
                uint16_t *words, size_t count) {
  if (!command(device, cmd))
    return false;
  wait_ms(1);
  uint8_t bytes[9]; // Largest response: three words and their CRCs.
  if (count > sizeof(bytes) / 3)
    return false;
  if (!checked(i2c_master_receive(device, bytes, count * 3, timeout_ms),
               "Read response"))
    return false;
  for (size_t i = 0; i < count; ++i) {
    const uint16_t word = (uint16_t(bytes[3 * i]) << 8) | bytes[3 * i + 1];
    const uint8_t expected = word_crc(word);
    if (expected != bytes[3 * i + 2]) {
      ESP_LOGE(tag, "CRC error: command=0x%04x word=%u expected=0x%02x got=0x%02x",
               unsigned(cmd), unsigned(i), unsigned(expected),
               unsigned(bytes[3 * i + 2]));
      return false;
    }
    words[i] = word;
  }
  return true;
}

void measure(i2c_master_dev_handle_t device) {
  wait_ms(1000); // Power-up communication readiness.
  // MCU reset need not reset the powered sensor. Return it to idle first.
  if (!command(device, 0x3f86))
    return;
  wait_ms(500);
  uint16_t serial[3];
  if (!read_words(device, 0x3682, serial, 3))
    return;
  ESP_LOGI(tag, "Serial number: %04X%04X%04X", unsigned(serial[0]),
           unsigned(serial[1]), unsigned(serial[2]));
  if (!command(device, 0x21b1))
    return;
  ESP_LOGI(tag, "Periodic measurement started (5 s interval), monitor only");
  unsigned not_ready_seconds = 0;
  for (;;) {
    wait_ms(1000);
    uint16_t ready;
    if (!read_words(device, 0xe4b8, &ready, 1))
      continue;
    if ((ready & 0x07ff) == 0) {
      if (++not_ready_seconds >= 30) {
        ESP_LOGW(tag, "No measurement ready for at least 30 successful polls");
        not_ready_seconds = 0;
      }
      continue;
    }
    not_ready_seconds = 0;
    uint16_t sample[3];
    if (!read_words(device, 0xec05, sample, 3))
      continue; // Discard the entire response on any CRC/transport error.
    if (sample[0] == 0) {
      ESP_LOGW(tag, "Invalid CO2 sample (0 ppm); discarded");
      continue;
    }
    const double temperature = -45.0 + 175.0 * sample[1] / 65535.0;
    const double humidity = 100.0 * sample[2] / 65535.0;
    ESP_LOGI(tag, "CO2=%u ppm, temperature=%.2f C, humidity=%.2f %%RH [accuracy unverified]",
             unsigned(sample[0]), temperature, humidity);
  }
}
} // namespace

void run_scd41_monitor() {
  ESP_LOGW(tag, "Isopropanol previously contacted the membrane: valid data/CRC "
                "does NOT confirm sensor accuracy");
  ESP_LOGI(tag, "I2C: SDA=GPIO0 SCL=GPIO1, 100 kHz, address=0x62");
  i2c_master_bus_config_t bus_config{};
  bus_config.i2c_port = I2C_NUM_0;
  bus_config.sda_io_num = GPIO_NUM_0;
  bus_config.scl_io_num = GPIO_NUM_1;
  bus_config.clk_source = I2C_CLK_SRC_DEFAULT;
  bus_config.glitch_ignore_cnt = 7;
  bus_config.flags.enable_internal_pullup = true;
  i2c_master_bus_handle_t bus = nullptr;
  if (!checked(i2c_new_master_bus(&bus_config, &bus), "Create I2C bus"))
    return;
  i2c_device_config_t device_config{};
  device_config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  device_config.device_address = 0x62;
  device_config.scl_speed_hz = 100000;
  i2c_master_dev_handle_t device = nullptr;
  if (checked(i2c_master_bus_add_device(bus, &device_config, &device),
              "Add SCD41")) {
    measure(device);
    checked(i2c_master_bus_rm_device(device), "Remove SCD41");
  }
  ESP_LOGE(tag, "SCD41 monitor stopped after initialization error; BLE remains active. "
                "Check wiring/power/pull-ups and restart");
  checked(i2c_del_master_bus(bus), "Delete I2C bus");
}
} // namespace lueftlotse
