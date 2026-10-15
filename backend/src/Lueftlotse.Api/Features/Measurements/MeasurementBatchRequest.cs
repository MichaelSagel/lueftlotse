namespace Lueftlotse.Api.Features.Measurements;

public sealed record MeasurementBatchRequest(
    Guid DeviceId, string? Source, List<MeasurementRequest?>? Measurements);

public sealed record MeasurementRequest(
    Guid MeasurementId, string? MeasuredAt, int? Ppm, string? Segment);

public sealed record MeasurementBatchResponse(int Received, int Inserted, int Duplicates);
