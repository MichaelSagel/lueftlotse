using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Lueftlotse.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Lueftlotse.Api.Features.Measurements;

public static partial class MeasurementBatchEndpoint
{
    private const int MaxBodyBytes = 256 * 1024;
    private const int MaxMeasurements = 500;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.Strict
    };

    public static void MapMeasurementEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/measurements/batch", Handle)
            .Accepts<MeasurementBatchRequest>("application/json")
            .Produces<MeasurementBatchResponse>()
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status409Conflict)
            .Produces(StatusCodes.Status413PayloadTooLarge);
    }

    private static async Task<IResult> Handle(HttpRequest request, LueftlotseDbContext database,
        CancellationToken cancellationToken)
    {
        if (request.ContentLength > MaxBodyBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        if (!request.HasJsonContentType()) return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);

        // Count actual bytes as well: Content-Length may be absent (chunked requests).
        using var body = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var length = await request.Body.ReadAsync(buffer.AsMemory(0,
                Math.Min(buffer.Length, MaxBodyBytes + 1 - (int)body.Length)), cancellationToken);
            if (length == 0) break;
            body.Write(buffer, 0, length);
            if (body.Length > MaxBodyBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        }

        MeasurementBatchRequest? batch;
        try
        {
            batch = JsonSerializer.Deserialize<MeasurementBatchRequest>(
                body.GetBuffer().AsSpan(0, (int)body.Length), JsonOptions);
        }
        catch (JsonException)
        {
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["Invalid JSON or field types."] });
        }

        var errors = new Dictionary<string, string[]>();
        var measurements = Validate(batch, errors);
        if (errors.Count != 0) return Results.ValidationProblem(errors);

        await using var transaction = await database.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var inserted = 0;
        // A common lock order prevents deadlocks for overlapping batches in opposite input order.
        foreach (var measurement in measurements.OrderBy(x => x.MeasurementId))
        {
            var affected = await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO measurements (measurement_id, device_id, source, measured_at, ppm, segment, received_at)
                VALUES ({measurement.MeasurementId}, {measurement.DeviceId}, {measurement.Source},
                        {measurement.MeasuredAt}, {measurement.Ppm}, {measurement.Segment}, {measurement.ReceivedAt})
                ON CONFLICT (measurement_id) DO NOTHING
                """, cancellationToken);
            if (affected == 1) { inserted++; continue; }

            // At READ COMMITTED, this new statement sees the winning concurrent transaction
            // after ON CONFLICT has waited for it. No row is updated, including received_at.
            var existing = await database.Measurements.AsNoTracking()
                .SingleAsync(x => x.MeasurementId == measurement.MeasurementId, cancellationToken);
            if (existing.DeviceId != measurement.DeviceId || existing.Source != measurement.Source ||
                existing.MeasuredAt != measurement.MeasuredAt || existing.Ppm != measurement.Ppm ||
                existing.Segment != measurement.Segment)
            {
                await transaction.RollbackAsync(cancellationToken);
                return Results.Problem(statusCode: StatusCodes.Status409Conflict,
                    title: "A measurement ID already exists with different data.");
            }
        }
        await transaction.CommitAsync(cancellationToken);
        return Results.Ok(new MeasurementBatchResponse(measurements.Count, inserted, measurements.Count - inserted));
    }

    private static List<Measurement> Validate(MeasurementBatchRequest? batch, Dictionary<string, string[]> errors)
    {
        if (batch is null) { errors["body"] = ["A batch is required."]; return []; }
        if (batch.DeviceId == Guid.Empty) errors["deviceId"] = ["A nonempty UUID is required."];
        if (batch.Source is not ("simulator" or "sensor")) errors["source"] = ["Use simulator or sensor."];
        if (batch.Measurements is null || batch.Measurements.Count is < 1 or > MaxMeasurements)
        {
            errors["measurements"] = ["Supply between 1 and 500 measurements."];
            return [];
        }
        var now = DateTime.UtcNow;
        var ids = new HashSet<Guid>();
        var result = new List<Measurement>(batch.Measurements.Count);
        for (var index = 0; index < batch.Measurements.Count; index++)
        {
            var entry = batch.Measurements[index];
            var field = $"measurements[{index}]";
            if (entry is null) { errors[field] = ["A measurement is required."]; continue; }
            if (entry.MeasurementId == Guid.Empty || !ids.Add(entry.MeasurementId))
                errors[$"{field}.measurementId"] = ["Supply a nonempty UUID unique within the batch."];
            var utcTime = default(DateTime);
            if (entry.MeasuredAt is null || !UtcTimestamp().IsMatch(entry.MeasuredAt) ||
                !DateTime.TryParse(entry.MeasuredAt, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out utcTime) ||
                utcTime > now.AddMinutes(5))
                errors[$"{field}.measuredAt"] = ["Supply an ISO 8601 UTC timestamp ending in Z, at most 5 minutes in the future."];
            if (entry.Ppm is null or < 1 or > 100000) errors[$"{field}.ppm"] = ["Supply an integer from 1 to 100000."];
            if (string.IsNullOrWhiteSpace(entry.Segment) || entry.Segment.EnumerateRunes().Count() > 80 || entry.Segment.Contains('\0'))
                errors[$"{field}.segment"] = ["Supply a nonempty segment of at most 80 characters without NUL."];
            // PostgreSQL timestamptz has microsecond precision. Reject finer nonzero digits
            // instead of silently merging distinct timestamps during idempotency comparison.
            if (utcTime.Ticks % 10 != 0) errors[$"{field}.measuredAt"] = ["Timestamp precision must not exceed microseconds."];
            result.Add(new Measurement
            {
                MeasurementId = entry.MeasurementId, DeviceId = batch.DeviceId, Source = batch.Source!,
                MeasuredAt = utcTime, Ppm = entry.Ppm ?? 0, Segment = entry.Segment!, ReceivedAt = now
            });
        }
        return result;
    }

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$", RegexOptions.CultureInvariant)]
    private static partial Regex UtcTimestamp();
}
