using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Lueftlotse.Api.Data;
using Lueftlotse.Api.Features.Measurements;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

namespace Lueftlotse.Api.IntegrationTests;

public sealed class MeasurementBatchTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    private const string Endpoint = "/api/measurements/batch";
    private static MeasurementRequest Reading(Guid? id = null, int ppm = 850) => new(
        id ?? Guid.NewGuid(), "2026-01-15T10:00:00.123456Z", ppm, "session:1");
    private static MeasurementBatchRequest Batch(params MeasurementRequest[] entries) =>
        new(Guid.NewGuid(), "simulator", entries.Cast<MeasurementRequest?>().ToList());
    private async Task<List<Measurement>> Stored(Guid deviceId)
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>()
            .Measurements.AsNoTracking().Where(x => x.DeviceId == deviceId).ToListAsync();
    }
    private async Task<MeasurementBatchResponse> Send(MeasurementBatchRequest batch)
    {
        using var client = fixture.CreateClient();
        using var response = await client.PostAsJsonAsync(Endpoint, batch, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MeasurementBatchResponse>())!;
    }

    [Fact]
    public async Task InsertsOriginalValuesInUtcAndPreservesSourceAndSegments()
    {
        var first = Reading();
        var second = Reading() with { Segment = "session:2", Ppm = 2000 };
        var batch = Batch(first, second) with { Source = "sensor" };
        Assert.Equal(new(2, 2, 0), await Send(batch));
        var rows = await Stored(batch.DeviceId);
        Assert.Equal(2, rows.Count);
        Assert.All(rows, row => { Assert.Equal("sensor", row.Source); Assert.Equal(DateTimeKind.Utc, row.MeasuredAt.Kind); Assert.Equal(DateTimeKind.Utc, row.ReceivedAt.Kind); });
        var row = Assert.Single(rows, row => row.MeasurementId == first.MeasurementId);
        Assert.Equal(DateTime.Parse(first.MeasuredAt!, null, System.Globalization.DateTimeStyles.AdjustToUniversal), row.MeasuredAt);
        Assert.Equal(first.Ppm, row.Ppm);
        Assert.Equal(first.Segment, row.Segment);
        Assert.Contains(rows, row => row.Segment == "session:2");
    }

    [Fact]
    public async Task RepeatedAndOverlappingBatchesDoNotChangeOriginalRows()
    {
        var first = Reading();
        var batch = Batch(first);
        await Send(batch);
        var original = Assert.Single(await Stored(batch.DeviceId));
        Assert.Equal(new(1, 0, 1), await Send(batch));
        var overlap = batch with { Measurements = [first, Reading()] };
        Assert.Equal(new(2, 1, 1), await Send(overlap));
        var after = Assert.Single(await Stored(batch.DeviceId), row => row.MeasurementId == first.MeasurementId);
        Assert.Equal(original.ReceivedAt, after.ReceivedAt);
    }

    [Theory]
    [InlineData("ppm")]
    [InlineData("time")]
    [InlineData("source")]
    [InlineData("segment")]
    [InlineData("device")]
    public async Task ConflictingImmutableFieldRollsBackEntireBatch(string field)
    {
        // A high ID makes the fresh row insert before the eventual conflict.
        var existing = Reading(Guid.Parse("f" + Guid.NewGuid().ToString("N")[1..]));
        var original = Batch(existing);
        await Send(original);
        var changed = field switch
        {
            "ppm" => existing with { Ppm = 851 },
            "time" => existing with { MeasuredAt = "2026-01-15T10:00:01.123456Z" },
            "segment" => existing with { Segment = "session:2" },
            _ => existing
        };
        var fresh = Reading(Guid.Parse("0" + Guid.NewGuid().ToString("N")[1..]));
        var conflicting = original with { Measurements = [fresh, changed] };
        if (field == "source") conflicting = conflicting with { Source = "sensor" };
        if (field == "device") conflicting = conflicting with { DeviceId = Guid.NewGuid() };
        using var client = fixture.CreateClient();
        using var response = await client.PostAsJsonAsync(Endpoint, conflicting, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>();
        Assert.False(await db.Measurements.AnyAsync(x => x.MeasurementId == fresh.MeasurementId, TestContext.Current.CancellationToken));
        var unchanged = await db.Measurements.SingleAsync(x => x.MeasurementId == existing.MeasurementId, TestContext.Current.CancellationToken);
        Assert.Equal(original.DeviceId, unchanged.DeviceId);
        Assert.Equal(850, unchanged.Ppm);
        Assert.Equal("simulator", unchanged.Source);
    }

    [Fact]
    public async Task ConcurrentIdenticalAndOverlappingRequestsInsertEachIdOnce()
    {
        var entries = Enumerable.Range(0, 12).Select(_ => Reading()).ToArray();
        var batch = Batch(entries);
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = Enumerable.Range(0, 8).Select(async index =>
        {
            await start.Task;
            return await Send(batch with { Measurements = (index % 2 == 0 ? entries : entries.Reverse()).Cast<MeasurementRequest?>().ToList() });
        }).ToArray();
        start.SetResult();
        var responses = await Task.WhenAll(calls);
        Assert.Equal(12, responses.Sum(response => response.Inserted));
        Assert.Equal(84, responses.Sum(response => response.Duplicates));
        Assert.Equal(12, (await Stored(batch.DeviceId)).Count);
    }

    [Fact]
    public async Task ConcurrentDifferentValuesHaveOneWinnerAndNoPartialLoser()
    {
        var shared = Reading(Guid.Parse("f" + Guid.NewGuid().ToString("N")[1..]));
        var firstNew = Reading(Guid.Parse("0" + Guid.NewGuid().ToString("N")[1..]));
        var secondNew = Reading(Guid.Parse("0" + Guid.NewGuid().ToString("N")[1..]));
        var first = Batch(firstNew, shared);
        var second = first with { Measurements = [secondNew, shared with { Ppm = 900 }] };
        using var firstClient = fixture.CreateClient();
        using var secondClient = fixture.CreateClient();
        var responses = await Task.WhenAll(firstClient.PostAsJsonAsync(Endpoint, first, TestContext.Current.CancellationToken),
            secondClient.PostAsJsonAsync(Endpoint, second, TestContext.Current.CancellationToken));
        try
        {
            Assert.Single(responses, r => r.StatusCode == HttpStatusCode.OK);
            Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Conflict);
            var rows = await Stored(first.DeviceId);
            Assert.Equal(2, rows.Count);
            Assert.Contains(rows, row => row.MeasurementId == shared.MeasurementId);
            var winnerNew = responses[0].IsSuccessStatusCode ? firstNew : secondNew;
            Assert.Contains(rows, row => row.MeasurementId == winnerNew.MeasurementId);
        }
        finally { foreach (var response in responses) response.Dispose(); }
    }

    [Theory]
    [InlineData("empty")][InlineData("too-many")][InlineData("duplicate")]
    [InlineData("device")][InlineData("source")][InlineData("id")][InlineData("null-entry")]
    [InlineData("ppm-zero")][InlineData("ppm-high")][InlineData("ppm-null")]
    [InlineData("segment-empty")][InlineData("segment-space")][InlineData("segment-long")][InlineData("segment-nul")]
    [InlineData("time-local")][InlineData("time-offset")][InlineData("time-invalid")][InlineData("time-future")]
    [InlineData("time-precision")]
    public async Task InvalidBatchDoesNotInsertAnyRows(string invalid)
    {
        var batch = Batch(Reading(), Reading());
        var item = batch.Measurements![1]!;
        switch (invalid)
        {
            case "empty": batch = batch with { Measurements = [] }; break;
            case "too-many": batch = Batch(Enumerable.Range(0, 501).Select(_ => Reading()).ToArray()); break;
            case "duplicate": batch.Measurements[1] = batch.Measurements[0]; break;
            case "device": batch = batch with { DeviceId = Guid.Empty }; break;
            case "source": batch = batch with { Source = "ble" }; break;
            case "id": batch.Measurements[1] = item with { MeasurementId = Guid.Empty }; break;
            case "null-entry": batch.Measurements[1] = null; break;
            case "ppm-zero": batch.Measurements[1] = item with { Ppm = 0 }; break;
            case "ppm-high": batch.Measurements[1] = item with { Ppm = 100001 }; break;
            case "ppm-null": batch.Measurements[1] = item with { Ppm = null }; break;
            case "segment-empty": batch.Measurements[1] = item with { Segment = "" }; break;
            case "segment-space": batch.Measurements[1] = item with { Segment = " \t" }; break;
            case "segment-long": batch.Measurements[1] = item with { Segment = new string('x', 81) }; break;
            case "segment-nul": batch.Measurements[1] = item with { Segment = "x\0y" }; break;
            case "time-local": batch.Measurements[1] = item with { MeasuredAt = "2026-01-01T10:00:00" }; break;
            case "time-offset": batch.Measurements[1] = item with { MeasuredAt = "2026-01-01T10:00:00+02:00" }; break;
            case "time-invalid": batch.Measurements[1] = item with { MeasuredAt = "2026-02-30T10:00:00Z" }; break;
            case "time-future": batch.Measurements[1] = item with { MeasuredAt = DateTime.UtcNow.AddMinutes(10).ToString("O") }; break;
            case "time-precision": batch.Measurements[1] = item with { MeasuredAt = "2026-01-01T10:00:00.1234567Z" }; break;
        }
        using var client = fixture.CreateClient();
        using var response = await client.PostAsJsonAsync(Endpoint, batch, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(await Stored(batch.DeviceId));
    }

    [Theory]
    [InlineData("null")][InlineData("{")][InlineData("{}")]
    [InlineData("{\"deviceId\":\"bad\"}")]
    public async Task RejectsMalformedOrMissingFields(string json)
    {
        using var client = fixture.CreateClient();
        using var response = await client.PostAsync(Endpoint, new StringContent(json, Encoding.UTF8, "application/json"), TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task RejectsFractionalStringAndMissingPpm()
    {
        using var client = fixture.CreateClient();
        foreach (var kind in new[] { "fractional", "string", "missing" })
        {
            var batch = Batch(Reading());
            var json = System.Text.Json.JsonSerializer.SerializeToNode(batch, System.Text.Json.JsonSerializerOptions.Web)!;
            if (kind == "missing") json["measurements"]![0]!.AsObject().Remove("ppm");
            else if (kind == "string") json["measurements"]![0]!["ppm"] = "850";
            else json["measurements"]![0]!["ppm"] = 850.5;
            using var response = await client.PostAsync(Endpoint, new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json"), TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Empty(await Stored(batch.DeviceId));
        }
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task EnforcesBodyLimitWithAndWithoutContentLength(bool chunked)
    {
        using var client = fixture.CreateClient();
        var bytes = Encoding.UTF8.GetBytes("{\"padding\":\"" + new string('x', 256 * 1024) + "\"}");
        using HttpContent content = chunked ? new UnknownLengthContent(bytes) : new ByteArrayContent(bytes);
        content.Headers.ContentType = new("application/json");
        using var response = await client.PostAsync(Endpoint, content, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact]
    public async Task AcceptsMaximumBatchAndPpmBoundaries()
    {
        var batch = Batch(Enumerable.Range(0, 500).Select(i => Reading(ppm: i % 2 == 0 ? 1 : 100000)).ToArray());
        Assert.Equal(new(500, 500, 0), await Send(batch));
        Assert.Equal(500, (await Stored(batch.DeviceId)).Count);
    }

    [Theory]
    [InlineData("source", "invalid", "23514")]
    [InlineData("ppm", "0", "23514")]
    [InlineData("segment", "", "23514")]
    [InlineData("segment", "long", "22001")]
    public async Task MigrationEnforcesDatabaseConstraints(string field, string invalid, string sqlState)
    {
        await using var connection = new NpgsqlConnection(fixture.TestConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("""
            INSERT INTO measurements (measurement_id, device_id, source, measured_at, ppm, segment, received_at)
            VALUES (@id, @device, @source, @time, @ppm, @segment, @time)
            """, connection);
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("device", Guid.NewGuid());
        command.Parameters.AddWithValue("source", field == "source" ? invalid : "simulator");
        command.Parameters.AddWithValue("time", DateTime.UtcNow);
        command.Parameters.AddWithValue("ppm", field == "ppm" ? int.Parse(invalid) : 850);
        command.Parameters.AddWithValue("segment", field == "segment" ? (invalid == "long" ? new string('x', 81) : invalid) : "session:1");
        var error = await Assert.ThrowsAsync<PostgresException>(async () => { await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken); });
        Assert.Equal(sqlState, error.SqlState);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WaitsForConcurrentInsertAndHandlesItsCommitOrRollback(bool commit)
    {
        var entry = Reading();
        var batch = Batch(entry);
        await using var connection = new NpgsqlConnection(fixture.TestConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(TestContext.Current.CancellationToken);
        await using var insert = new NpgsqlCommand("""
            INSERT INTO measurements (measurement_id, device_id, source, measured_at, ppm, segment, received_at)
            VALUES (@id, @device, 'simulator', @time, @ppm, @segment, @time)
            """, connection, transaction);
        insert.Parameters.AddWithValue("id", entry.MeasurementId);
        insert.Parameters.AddWithValue("device", batch.DeviceId);
        insert.Parameters.AddWithValue("time", DateTime.Parse(entry.MeasuredAt!, null,
            System.Globalization.DateTimeStyles.AdjustToUniversal));
        insert.Parameters.AddWithValue("ppm", entry.Ppm!.Value);
        insert.Parameters.AddWithValue("segment", entry.Segment!);
        await insert.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
        using var client = fixture.CreateClient();
        var request = client.PostAsJsonAsync(Endpoint, batch, TestContext.Current.CancellationToken);
        await using var observer = new NpgsqlConnection(fixture.TestConnection);
        await observer.OpenAsync(TestContext.Current.CancellationToken);
        await using var waiting = new NpgsqlCommand("""
            SELECT EXISTS (SELECT FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND pid <> pg_backend_pid())
            """, observer);
        var blocked = false;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if ((bool)(await waiting.ExecuteScalarAsync(TestContext.Current.CancellationToken))!)
            { blocked = true; break; }
            await Task.Delay(25, TestContext.Current.CancellationToken);
        }
        // Release the held transaction even when a regression makes the wait assertion fail.
        if (commit) await transaction.CommitAsync(TestContext.Current.CancellationToken);
        else await transaction.RollbackAsync(TestContext.Current.CancellationToken);
        using var response = await request;
        Assert.True(blocked, "The request must wait for the conflicting uncommitted PostgreSQL row.");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = await response.Content.ReadFromJsonAsync<MeasurementBatchResponse>(TestContext.Current.CancellationToken);
        Assert.Equal(commit ? new(1, 0, 1) : new MeasurementBatchResponse(1, 1, 0), result);
        Assert.Single(await Stored(batch.DeviceId));
    }

    [Fact]
    public async Task MigrationHasExpectedIndexAndNoPendingModelChanges()
    {
        await using var scope = fixture.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>();
        Assert.Single(await database.Database.GetAppliedMigrationsAsync(TestContext.Current.CancellationToken));
        Assert.False(database.Database.HasPendingModelChanges());
        await using var connection = new NpgsqlConnection(fixture.TestConnection);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = new NpgsqlCommand("""
            SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
                AND indexname = 'ix_measurements_device_id_measured_at'
            """, connection);
        var index = (string)(await command.ExecuteScalarAsync(TestContext.Current.CancellationToken))!;
        Assert.Contains("(device_id, measured_at)", index);
    }
    private sealed class UnknownLengthContent(byte[] bytes) : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(bytes).AsTask();
    }
}
