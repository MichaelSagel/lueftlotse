# Backend

.NET SDK 10.0.402 (latestPatch), EF Core 10.0.13, Npgsql EF provider 10.0.3.
The API uses `ConnectionStrings:Lueftlotse` from configuration; local development
stores its value in .NET User Secrets. Never commit credentials.

## Measurement batches

`POST /api/measurements/batch` accepts JSON:

```json
{
  "deviceId": "2361e85a-a975-481d-aa22-ef01a9f912b0",
  "source": "simulator",
  "measurements": [{
    "measurementId": "84e15748-cd76-450d-a443-1792f223006b",
    "measuredAt": "2026-01-15T10:00:00.000Z",
    "ppm": 850,
    "segment": "session:1"
  }]
}
```

Limits: 1–500 entries, 256 KiB of actual request bytes (also without Content-Length),
nonempty UUIDs, source `simulator` or `sensor`, integer ppm 1–100000,
nonblank segment of at most 80 Unicode characters. Time must be ISO 8601 UTC with
`Z`, no more than five minutes in the future. Historical timestamps are accepted.
PostgreSQL stores microseconds: nonzero submicrosecond digits are rejected rather
than silently changing an immutable measurement. Duplicate IDs within a batch
are invalid.

Success: 200 with `received`, `inserted`, `duplicates`. An existing ID with identical
immutable fields is a successful repeat; `received_at` is unchanged. Different
fields return 409 and roll back the entire batch. Validation returns 400; an
oversized body returns 413. IDs are processed in a common order inside a READ
COMMITTED transaction. The primary key and ON CONFLICT handle concurrent requests;
a separate query compares the committed winning row. Parameters are never SQL-concatenated.

Do not generate device IDs from BLE addresses. Keep measurement UUIDs across retries.
No migration is applied automatically at startup.

## Integration tests

`GET /api/measurements?from=2026-02-01T00:00:00Z&to=2026-02-02T00:00:00Z`
reads PostgreSQL through an EF Core no-tracking projection. Required UTC ISO 8601
timestamps end in Z (microsecond precision); the period is [from, to), with from
strictly before to. Optional deviceId is a nonempty UUID. pageSize defaults to 50
and accepts 1–200. Invalid/duplicate parameters and malformed cursors return 400.
The response is `{ items: [...], nextCursor: string | null }`; each item contains
measurementId, deviceId, source, measuredAt, ppm, segment and receivedAt.
Order is measuredAt DESC, measurementId DESC. Pass nextCursor as the next request's
cursor parameter with the same device/from/to filters. A null cursor ends traversal.
Cursors are versioned base64url tokens, bound to those filters, not authentication
credentials. Page size may change between pages. Pagination is not a database
snapshot: concurrent inserts ahead of the cursor require a fresh traversal.
No schema change or automatic migration is involved.

Tests require real PostgreSQL, not Docker or an in-memory substitute. Inject these
variables into the test process without printing their values:

- `LUEFTLOTSE_TEST_ADMIN_CONNECTION`: a loopback connection to maintenance database
  `postgres`, with permission to create/drop test databases.
- `LUEFTLOTSE_TEST_APP_CONNECTION`: the existing local `lueftlotse_app` connection.
  The fixture always replaces its database name before opening any connection.

From the repository root:

```text
dotnet build backend/Lueftlotse.slnx --configuration Release
dotnet run --project backend/tests/Lueftlotse.Api.IntegrationTests --configuration Release
```

The xUnit executable uses Microsoft Testing Platform. From `backend/`, `dotnet test`
uses the same runner configured in `global.json`.

The fixture creates a fresh `lueftlotse_test_<32 hex digits>` database owned by the
application role, applies the EF migration, runs HTTP tests through WebApplicationFactory,
and drops only that generated database afterwards. It never clears or migrates
`lueftlotse`. Keep test credentials in temporary process environment or a local
secret manager, and clear them afterwards.

The initial migration is under `src/Lueftlotse.Api/Data/Migrations` and was tested
only in temporary test databases. Applying it to the working database is a separate step.
