idf_component_register(SRCS "main.cpp" "scd41.cpp" INCLUDE_DIRS "."
    REQUIRES log ble_server esp_driver_i2c freertos)
