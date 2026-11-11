package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;

/** Validated query and period-bound keyset cursor. All SQL identifiers come from this class. */
final class NativeHistoryQuery {
    final long from;
    final long to;
    final String deviceId;
    final String sort;
    final int pageSize;
    final boolean byPpm;
    final String direction;
    final String comparison;
    final String cursor;
    final long snapshot;
    final long lastTime;
    final long lastRow;
    final int lastPpm;

    NativeHistoryQuery(String fromMs, String toMs, String deviceId, String sort, int pageSize, String cursor) {
        from = decimal(fromMs);
        to = decimal(toMs);
        if (from >= to || from < -8640000000000000L || to > 8640000000000000L) {
            throw new IllegalArgumentException("Invalid history period [from, to)");
        }
        this.deviceId = deviceId == null || deviceId.isEmpty() ? "" : Codec.uuid(deviceId);
        this.sort = sort == null ? "time-desc" : sort;
        if (!this.sort.matches("(time|ppm)-(asc|desc)")) {
            throw new IllegalArgumentException("Invalid history sort");
        }
        if (pageSize < 1 || pageSize > 50) {
            throw new IllegalArgumentException("History page size must be between 1 and 50");
        }
        this.pageSize = pageSize;
        byPpm = this.sort.startsWith("ppm-");
        boolean ascending = this.sort.endsWith("-asc");
        direction = ascending ? " ASC" : " DESC";
        comparison = ascending ? " > ?" : " < ?";
        this.cursor = cursor;
        if (cursor == null) {
            snapshot = 0;
            lastTime = 0;
            lastRow = 0;
            lastPpm = 0;
        } else {
            if (cursor.length() > 512 || !cursor.startsWith(prefix())) {
                throw new IllegalArgumentException("History cursor does not match filters/sort/page size");
            }
            String[] values = cursor.substring(prefix().length()).split("\\|", -1);
            if (values.length != 4) {
                throw new IllegalArgumentException("Invalid history cursor");
            }
            snapshot = decimal(values[0]);
            lastTime = decimal(values[1]);
            long ppm = decimal(values[2]);
            lastRow = decimal(values[3]);
            if (snapshot < 1 || lastRow < 1 || lastRow > snapshot || lastTime < from || lastTime >= to
                    || ppm < 1 || ppm > 100000) {
                throw new IllegalArgumentException("Invalid history cursor values");
            }
            lastPpm = (int) ppm;
        }
    }

    private static long decimal(String value) {
        if (value == null) {
            throw new IllegalArgumentException("Expected decimal milliseconds/cursor value");
        }
        long number = Long.parseLong(value);
        if (!Long.toString(number).equals(value)) {
            throw new IllegalArgumentException("Expected canonical decimal value");
        }
        return number;
    }

    private String prefix() {
        return "v1|" + from + "|" + to + "|" + deviceId + "|" + sort + "|" + pageSize + "|";
    }

    String next(long snapshot, long time, int ppm, long row) {
        return prefix() + snapshot + "|" + time + "|" + ppm + "|" + row;
    }

    String orderBy() {
        return (byPpm ? "ppm" + direction + ", " : "") + "measured_at" + direction + ", rowid" + direction;
    }
}
