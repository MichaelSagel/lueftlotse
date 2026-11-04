using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Lueftlotse.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Lueftlotse.Api.Features.Measurements;

public sealed record MeasurementDto(Guid MeasurementId, Guid DeviceId, string Source,
    DateTime MeasuredAt, int Ppm, string Segment, DateTime ReceivedAt);
public sealed record MeasurementPage(IReadOnlyList<MeasurementDto> Items, string? NextCursor);

public static class MeasurementHistoryEndpoint
{
    public static async Task<IResult> Handle(HttpRequest request, LueftlotseDbContext database, CancellationToken cancellationToken)
    {
        var q = request.Query;
        IResult Invalid() => Results.ValidationProblem(new Dictionary<string, string[]> { ["query"] = ["Supply valid UTC from/to, optional deviceId, pageSize 1–200 sort time-desc/time-asc/ppm-desc/ppm-asc and an unchanged nextCursor for the same filters and sort."] });
        foreach (var key in new[] { "from", "to", "deviceId", "pageSize", "cursor", "sort" })
            if (q.ContainsKey(key) && q[key].Count != 1) return Invalid();
        if (!Utc(q["from"].ToString(), out var from) || !Utc(q["to"].ToString(), out var to) || from >= to) return Invalid();
        Guid? device = null;
        if (q.ContainsKey("deviceId"))
        {
            if (!Guid.TryParseExact(q["deviceId"], "D", out var parsed) || parsed == Guid.Empty) return Invalid();
            device = parsed;
        }
        var size = 50;
        if (q.ContainsKey("pageSize") && (!int.TryParse(q["pageSize"], NumberStyles.None, CultureInfo.InvariantCulture, out size) || size is < 1 or > 200)) return Invalid();
        var sort = q.ContainsKey("sort") ? q["sort"].ToString() : "time-desc";
        if (sort is not ("time-desc" or "time-asc" or "ppm-desc" or "ppm-asc")) return Invalid();
        var ppmSort = sort.StartsWith("ppm-", StringComparison.Ordinal);
        var scope = string.Join('|', "1", from.Ticks.ToString(CultureInfo.InvariantCulture), to.Ticks.ToString(CultureInfo.InvariantCulture), device?.ToString("N") ?? "-");
        // Preserve the existing default cursor format for older clients.
        if (sort != "time-desc") scope = "2|" + scope[2..] + "|" + sort;
        var scopeLength = sort == "time-desc" ? 4 : 5;
        DateTime? lastTime = null; Guid lastId = default; var lastPpm = 0;
        if (q.ContainsKey("cursor"))
        {
            var token = q["cursor"].ToString();
            if (token.Length is < 1 or > 512 || !Regex.IsMatch(token, "^[A-Za-z0-9_-]+$")) return Invalid();
            try
            {
                var text = Encoding.UTF8.GetString(Convert.FromBase64String(token.Replace('-', '+').Replace('_', '/') + new string('=', (4 - token.Length % 4) % 4)));
                var parts = text.Split('|');
                if (parts.Length != scopeLength + (ppmSort ? 3 : 2) || string.Join('|', parts.Take(scopeLength)) != scope || Encode(text) != token ||
                    !long.TryParse(parts[^2], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) || parts[^2] != ticks.ToString(CultureInfo.InvariantCulture) || ticks < from.Ticks || ticks >= to.Ticks || ticks % 10 != 0 ||
                    !Guid.TryParseExact(parts[^1], "N", out lastId) || lastId == Guid.Empty) return Invalid();
                if (ppmSort && (!int.TryParse(parts[scopeLength], NumberStyles.None, CultureInfo.InvariantCulture, out lastPpm) ||
                    lastPpm is < 1 or > 100000 || parts[scopeLength] != lastPpm.ToString(CultureInfo.InvariantCulture))) return Invalid();
                lastTime = new DateTime(ticks, DateTimeKind.Utc);
            }
            catch (FormatException) { return Invalid(); }
        }
        var query = database.Measurements.AsNoTracking().Where(x => x.MeasuredAt >= from && x.MeasuredAt < to);
        if (device.HasValue) query = query.Where(x => x.DeviceId == device.Value);
        if (lastTime.HasValue)
        {
            if (sort == "time-asc") query = query.Where(x => x.MeasuredAt > lastTime.Value || (x.MeasuredAt == lastTime.Value && x.MeasurementId.CompareTo(lastId) > 0));
            else if (sort == "time-desc") query = query.Where(x => x.MeasuredAt < lastTime.Value || (x.MeasuredAt == lastTime.Value && x.MeasurementId.CompareTo(lastId) < 0));
            else if (sort == "ppm-asc") query = query.Where(x => x.Ppm > lastPpm || (x.Ppm == lastPpm && (x.MeasuredAt < lastTime.Value || (x.MeasuredAt == lastTime.Value && x.MeasurementId.CompareTo(lastId) < 0))));
            else query = query.Where(x => x.Ppm < lastPpm || (x.Ppm == lastPpm && (x.MeasuredAt < lastTime.Value || (x.MeasuredAt == lastTime.Value && x.MeasurementId.CompareTo(lastId) < 0))));
        }
        var ordered = sort switch
        {
            "time-asc" => query.OrderBy(x => x.MeasuredAt).ThenBy(x => x.MeasurementId),
            "ppm-asc" => query.OrderBy(x => x.Ppm).ThenByDescending(x => x.MeasuredAt).ThenByDescending(x => x.MeasurementId),
            "ppm-desc" => query.OrderByDescending(x => x.Ppm).ThenByDescending(x => x.MeasuredAt).ThenByDescending(x => x.MeasurementId),
            _ => query.OrderByDescending(x => x.MeasuredAt).ThenByDescending(x => x.MeasurementId),
        };
        var rows = await ordered
            .Select(x => new MeasurementDto(x.MeasurementId, x.DeviceId, x.Source, x.MeasuredAt, x.Ppm, x.Segment, x.ReceivedAt))
            .Take(size + 1).ToListAsync(cancellationToken);
        var more = rows.Count > size;
        if (more) rows.RemoveAt(size);
        var last = rows.LastOrDefault();
        return Results.Ok(new MeasurementPage(rows, more && last is not null
            ? Encode(scope + (ppmSort ? "|" + last.Ppm.ToString(CultureInfo.InvariantCulture) : "") + "|" + last.MeasuredAt.Ticks.ToString(CultureInfo.InvariantCulture) + "|" + last.MeasurementId.ToString("N")) : null));
    }
    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static bool Utc(string value, out DateTime time)
    {
        time = default;
        return Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$") &&
            DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out time) && time.Ticks % 10 == 0;
    }
}
