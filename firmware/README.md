# Первый запуск: ESP32-C3 Super Mini

Нужны установленный через EIM ESP-IDF **6.1**, USB-C кабель с передачей данных
и Android-приложение Lüftlotse. Ниже — инструкция для Windows; команды
выполняются из **корня репозитория lueftlotse**, а не из mobile или firmware.

## 1. Окружение и сборка

В EIM откройте **Manage Installations → Open Dashboard**, для установленной
версии **v6.1** нажмите **Open IDF Terminal**. Можно использовать созданный EIM
ярлык PowerShell этой версии. Он активирует отдельное Python-окружение и
инструменты ESP-IDF для терминала; системный PATH менять не нужно.

В активированном терминале перейдите в корень репозитория и выполните:

~~~powershell
idf.py --version
idf.py -C firmware -D SDKCONFIG=build/sdkconfig build
~~~

Версия должна быть v6.1. Target esp32c3 и NimBLE заданы в sdkconfig.defaults.
Генерируемая конфигурация находится в firmware/build/sdkconfig; старый
firmware/sdkconfig этой командой не используется. Образ приложения:
firmware/build/lueftlotse_firmware.bin. Build и локальные конфигурации исключены
из Git. Обычная сборка не проверяет работу радио.

## 2. COM-порт, прошивка и monitor

Подключите плату к USB. В **Диспетчере устройств → Порты (COM и LPT)**
найдите порт, исчезающий при отключении платы и появляющийся при подключении.
При native USB он может называться USB Serial Device. Не выбирайте порт телефона.
Ниже **COM7 — пример**: замените его своим портом; закройте другие serial-терминалы.

~~~powershell
idf.py -C firmware -D SDKCONFIG=build/sdkconfig -p COM7 flash
idf.py -C firmware -D SDKCONFIG=build/sdkconfig -p COM7 monitor
~~~

Ожидается строка `Lueftlotse firmware started`. Если стартовый лог пропущен,
кратко нажмите RESET. Выход из monitor — **Ctrl+]**; перед новой прошивкой
освободите COM-порт. Текущая конфигурация выводит логи также через вторичную
USB Serial/JTAG консоль; основной UART использует 115200 baud.

Если автоматический вход в режим прошивки не сработал (в том числе при первом
подключении через native USB):

1. Зажмите **BOOT**.
2. Кратко нажмите и отпустите **RESET/RST**, продолжая держать BOOT.
3. Отпустите BOOT, заново проверьте COM-порт и повторите команду flash.
4. После успешной прошивки, если приложение не запустилось, нажмите RESET
   с отпущенной BOOT, затем откройте monitor.

**Не используйте erase-flash как обычный шаг.** Полное стирание удаляет NVS,
включая постоянный deviceId. Обычная flash при неизменной таблице разделов
сохраняет NVS; прошивка не стирает её автоматически при ошибках.

## 3. Проверка в Android

Включите Bluetooth, откройте **Gerät verbinden**, запустите поиск, выберите
**Lueftlotse → Verbinden**. Полное имя передаётся в scan response, UUID сервиса —
в advertising. Приложение читает Info, проверяет v1.0, подписывается на Events,
отправляет GET_STATUS и ждёт STATUS с соответствующим requestId.

Ожидаются **STATUS bestätigt** и deviceId. Info.capabilities = 0x0000;
STATUS сообщает пустой журнал, timeValid=0 и storageState=0.
Успешное соединение не означает получение CO₂: главный экран остаётся
в режиме **Simulator**. Датчик, журнал, FETCH и **TIME_SET ещё не реализованы**;
догрузку измерений проверять пока нельзя.

## 4. Идентичность после перезапуска

Запишите deviceId из Android UI. Перезапустите плату кнопкой RESET или
отключением питания, снова найдите её и подключитесь: **deviceId должен
остаться тем же**, а **bootId в новом STATUS должен измениться**.

bootId пока не показан в Android UI. Для его отдельной проверки отключите
Lüftlotse от платы (допускается один central) и используйте BLE GATT-инспектор:

- UUID Info, Control и Events приведены в [спецификации](../docs/ble-protocol-v1.md).
- Подпишитесь на Events и отправьте в Control через **write with response**
  фиксированный GET_STATUS: `010134120001f150a9d0`.
- Сохраните четыре фрагмента STATUS по порядку. Для сборки удалите 6 байт
  заголовка каждого фрагмента, соедините payload и проверьте/удалите последние
  4 байта CRC согласно спецификации. В 52-байтном body bootId занимает байты
  **2..17** (смещения от нуля), после двухбайтного requestId.
- Повторите после перезапуска и нового подключения. Тот же GET_STATUS допустим
  на новом соединении; на одном соединении каждый запрос требует нового
  messageId и пересчитанного CRC. UUID bootId сравнивайте в каноническом порядке.

Сохранение NVS, BLE-обмен, повторное подключение и ограничения числа соединений
требуют проверки на настоящей плате; успешная сборка и QEMU-тесты кодека их
не подтверждают. Pairing и контроль доступа пока не реализованы.

## Официальные инструкции ESP-IDF 6.1

- [Windows: активация EIM, build, flash, monitor](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/get-started/windows-start-project.html)
- [COM-порт и ручной BOOT/RESET](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/get-started/establish-serial-connection.html)
- [USB Serial/JTAG console](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/api-guides/usb-serial-jtag-console.html)
