namespace Lueftlotse.Api.Features.Measurements;

public sealed class Measurement
{
    public Guid MeasurementId { get; init; }
    public Guid DeviceId { get; init; }
    public required string Source { get; init; }
    public DateTime MeasuredAt { get; init; }
    public int Ppm { get; init; }
    public required string Segment { get; init; }
    public DateTime ReceivedAt { get; init; }
}
