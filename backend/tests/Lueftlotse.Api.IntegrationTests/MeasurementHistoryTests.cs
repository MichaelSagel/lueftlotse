using System.Net;
using System.Net.Http.Json;
using Lueftlotse.Api.Data;
using Lueftlotse.Api.Features.Measurements;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Lueftlotse.Api.IntegrationTests;

public sealed class MeasurementHistoryTests(PostgresFixture fixture) : IClassFixture<PostgresFixture>
{
    private const string Range = "from=2026-02-01T00:00:00Z&to=2026-02-02T00:00:00Z";
    private async Task<Guid[]> Seed(Guid device)
    {
        var ids = new[] { "01000000-0000-0000-0000-000000000001", "7fffffff-0000-0000-0000-000000000001", "80000000-0000-0000-0000-000000000001", "ffffffff-0000-0000-0000-000000000001" }.Select(Guid.Parse).ToArray();
        // Unique low bytes keep fixtures independent while preserving UUID comparison boundaries.
        ids = ids.Select(id => Guid.Parse(id.ToString()[..24] + device.ToString("N")[..12])).ToArray();
        await using var scope = fixture.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>();
        var start = new DateTime(2026, 2, 1, 0, 0, 0, DateTimeKind.Utc);
        for (var i = 0; i < ids.Length; i++) db.Measurements.Add(new Measurement { MeasurementId = ids[i], DeviceId = device, Source = "sensor", MeasuredAt = start, Ppm = 800 + i, Segment = "history-test", ReceivedAt = start });
        foreach (var time in new[] { start.AddTicks(-10), start.AddDays(1) })
            db.Measurements.Add(new Measurement { MeasurementId = Guid.NewGuid(), DeviceId = device, Source = "sensor", MeasuredAt = time, Ppm = 999, Segment = "boundary", ReceivedAt = start });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        return ids.Reverse().ToArray();
    }
    private async Task<MeasurementPage> Get(string query)
    {
        using var client = fixture.CreateClient();
        using var response = await client.GetAsync("/api/measurements?" + query, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<MeasurementPage>())!;
    }
    [Fact]
    public async Task HalfOpenRangeAndDeviceFilterReturnDtoInStableUuidOrder()
    {
        var device = Guid.NewGuid(); var expected = await Seed(device); await Seed(Guid.NewGuid());
        var page = await Get(Range + "&deviceId=" + device);
        Assert.Equal(expected, page.Items.Select(x => x.MeasurementId)); Assert.Null(page.NextCursor);
        Assert.All(page.Items, row => { Assert.Equal(device, row.DeviceId); Assert.Equal("sensor", row.Source); Assert.Equal(DateTimeKind.Utc, row.MeasuredAt.Kind); });
        var all = await Get(Range); Assert.True(all.Items.Count >= 8);
    }
    [Fact]
    public async Task CursorTraversesEqualTimestampsWithoutDuplicatesOrMissingRows()
    {
        var device = Guid.NewGuid(); var expected = await Seed(device);
        var query = Range + "&deviceId=" + device + "&pageSize=2";
        var first = await Get(query); Assert.Equal(expected.Take(2), first.Items.Select(x => x.MeasurementId)); Assert.NotNull(first.NextCursor);
        var second = await Get(query + "&cursor=" + first.NextCursor);
        Assert.Equal(expected.Skip(2), second.Items.Select(x => x.MeasurementId)); Assert.Null(second.NextCursor);
        using var client = fixture.CreateClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/measurements?" + Range + "&cursor=" + first.NextCursor, TestContext.Current.CancellationToken)).StatusCode);
    }
    [Fact]
    public async Task DefaultAndMaximumPageSizesSortNewerMeasurementsFirst()
    {
        var device = Guid.NewGuid();
        var start = new DateTime(2026, 2, 1, 0, 0, 0, DateTimeKind.Utc);
        await using (var scope = fixture.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>();
            db.Measurements.AddRange(Enumerable.Range(0, 205).Select(i => new Measurement {
                MeasurementId = Guid.NewGuid(), DeviceId = device, Source = "simulator", MeasuredAt = start.AddSeconds(i),
                Ppm = 800, Segment = "pages", ReceivedAt = start }));
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        }
        var query = Range + "&deviceId=" + device;
        var first = await Get(query); Assert.Equal(50, first.Items.Count); Assert.NotNull(first.NextCursor);
        Assert.Equal(start.AddSeconds(204), first.Items[0].MeasuredAt);
        Assert.Equal(first.Items.OrderByDescending(x => x.MeasuredAt), first.Items);
        var large = await Get(query + "&pageSize=200"); Assert.Equal(200, large.Items.Count);
        var tail = await Get(query + "&pageSize=200&cursor=" + large.NextCursor);
        Assert.Equal(5, tail.Items.Count); Assert.Null(tail.NextCursor);
        Assert.Equal(205, large.Items.Concat(tail.Items).Select(x => x.MeasurementId).Distinct().Count());
    }
    [Fact]
    public async Task EmptyResultHasNoCursor()
    {
        var page = await Get(Range + "&deviceId=" + Guid.NewGuid()); Assert.Empty(page.Items); Assert.Null(page.NextCursor);
    }
    [Theory]
    [InlineData("")]
    [InlineData("from=2026-02-01T00:00:00Z")]
    [InlineData("from=2026-02-01T00:00:00&to=2026-02-02T00:00:00Z")]
    [InlineData("from=2026-02-02T00:00:00Z&to=2026-02-01T00:00:00Z")]
    [InlineData("from=2026-02-01T00:00:00Z&to=2026-02-01T00:00:00Z")]
    [InlineData(Range + "&deviceId=bad")]
    [InlineData(Range + "&pageSize=0")]
    [InlineData(Range + "&pageSize=201")]
    [InlineData(Range + "&pageSize=1.5")]
    [InlineData(Range + "&cursor=garbage")]
    [InlineData(Range + "&cursor=")]
    [InlineData("from=2026-02-01T00:00:00+00:00&to=2026-02-02T00:00:00Z")]
    [InlineData("from=2026-02-30T00:00:00Z&to=2026-03-02T00:00:00Z")]
    [InlineData("from=2026-02-01T00:00:00.0000001Z&to=2026-02-02T00:00:00Z")]
    [InlineData(Range + "&pageSize=1&pageSize=2")]
    public async Task InvalidQueryReturns400(string query)
    {
        using var client = fixture.CreateClient();
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/measurements?" + query, TestContext.Current.CancellationToken)).StatusCode);
    }
}
