#pragma once

namespace lueftlotse {
// Runs in the app_main task; NimBLE continues in its own host task.
void run_scd41_monitor();
}
