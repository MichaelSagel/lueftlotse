idf_component_register(SRCS "ble_server.cpp" "live_preview.cpp" INCLUDE_DIRS "include"
    REQUIRES ble_protocol bt nvs_flash esp_timer esp_hw_support bootloader_support log freertos)
