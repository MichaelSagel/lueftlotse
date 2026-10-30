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
        IResult Invalid() => Results.ValidationProblem(new Dictionary<string, string[]> { ["query"] = ["Supply valid UTC from/to, optional deviceId, pageSize 1–200 and an unchanged nextCursor for the same filters."] });
        foreach (var key in new[] { "from", "to", "deviceId", "pageSize", "cursor" })
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
        var scope = string.Join('|', "1", from.Ticks.ToString(CultureInfo.InvariantCulture), to.Ticks.ToString(CultureInfo.InvariantCulture), device?.ToString("N") ?? "-");
        DateTime? lastTime = null; Guid lastId = default;
        if (q.ContainsKey("cursor"))
        {
            var token = q["cursor"].ToString();
            if (token.Length is < 1 or > 512 || !Regex.IsMatch(token, "^[A-Za-z0-9_-]+$")) return Invalid();
            try
            {
                var text = Encoding.UTF8.GetString(Convert.FromBase64String(token.Replace('-', '+').Replace('_', '/') + new string('=', (4 - token.Length % 4) % 4)));
                var parts = text.Split('|');
                if (parts.Length != 6 || string.Join('|', parts.Take(4)) != scope || Encode(text) != token ||
                    !long.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) || parts[4] != ticks.ToString(CultureInfo.InvariantCulture) || ticks < from.Ticks || ticks >= to.Ticks || ticks % 10 != 0 ||
                    !Guid.TryParseExact(parts[5], "N", out lastId) || lastId == Guid.Empty) return Invalid();
                lastTime = new DateTime(ticks, DateTimeKind.Utc);
            }
            catch (FormatException) { return Invalid(); }
        }
        var query = database.Measurements.AsNoTracking().Where(x => x.MeasuredAt >= from && x.MeasuredAt < to);
        if (device.HasValue) query = query.Where(x => x.DeviceId == device.Value);
        if (lastTime.HasValue) query = query.Where(x => x.MeasuredAt < lastTime.Value || (x.MeasuredAt == lastTime.Value && x.MeasurementId.CompareTo(lastId) < 0));
        var rows = await query.OrderByDescending(x => x.MeasuredAt).ThenByDescending(x => x.MeasurementId)
            .Select(x => new MeasurementDto(x.MeasurementId, x.DeviceId, x.Source, x.MeasuredAt, x.Ppm, x.Segment, x.ReceivedAt))
            .Take(size + 1).ToListAsync(cancellationToken);
        var more = rows.Count > size;
        if (more) rows.RemoveAt(size);
        var last = rows.LastOrDefault();
        return Results.Ok(new MeasurementPage(rows, more && last is not null
            ? Encode(scope + "|" + last.MeasuredAt.Ticks.ToString(CultureInfo.InvariantCulture) + "|" + last.MeasurementId.ToString("N")) : null));
    }
    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static bool Utc(string value, out DateTime time)
    {
        time = default;
        return Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$") &&
            DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out time) && time.Ticks % 10 == 0;
    }
}
