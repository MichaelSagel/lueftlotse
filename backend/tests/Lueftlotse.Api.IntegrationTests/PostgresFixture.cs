using Lueftlotse.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using Xunit;

namespace Lueftlotse.Api.IntegrationTests;

public sealed class PostgresFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly string databaseName = "lueftlotse_test_" + Guid.NewGuid().ToString("N");
    private string? adminConnection;
    private bool created;
    public string TestConnection { get; private set; } = "";

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
            new Dictionary<string, string?> { ["ConnectionStrings:Lueftlotse"] = TestConnection }));
        builder.ConfigureLogging(logging => logging.ClearProviders());
    }

    public async ValueTask InitializeAsync()
    {
        adminConnection = Environment.GetEnvironmentVariable("LUEFTLOTSE_TEST_ADMIN_CONNECTION")
            ?? throw new InvalidOperationException("Set LUEFTLOTSE_TEST_ADMIN_CONNECTION to a local postgres maintenance connection.");
        var admin = new NpgsqlConnectionStringBuilder(adminConnection);
        if (admin.Host != "127.0.0.1" || admin.Database != "postgres")
            throw new InvalidOperationException("Test provisioning requires loopback and the postgres maintenance database.");
        var app = new NpgsqlConnectionStringBuilder(
            Environment.GetEnvironmentVariable("LUEFTLOTSE_TEST_APP_CONNECTION")
            ?? throw new InvalidOperationException("Set LUEFTLOTSE_TEST_APP_CONNECTION using a dedicated local application role."));
        if (app.Host != "127.0.0.1" || app.Port != admin.Port || app.Username != "lueftlotse_app")
            throw new InvalidOperationException("Unexpected test application connection settings.");
        app.Database = databaseName;
        TestConnection = app.ConnectionString;
        await using var connection = new NpgsqlConnection(adminConnection);
        await connection.OpenAsync();
        // Only this freshly generated name may be created or removed. Never reuse a supplied database.
        await using var command = new NpgsqlCommand(
            $"CREATE DATABASE {QuotedTestDatabase()} OWNER lueftlotse_app", connection);
        await command.ExecuteNonQueryAsync();
        created = true;
        try
        {
            await using var scope = Services.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<LueftlotseDbContext>();
            await database.Database.MigrateAsync();
        }
        catch { await DisposeAsync(); throw; }
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        if (!created) return;
        NpgsqlConnection.ClearAllPools();
        await using var connection = new NpgsqlConnection(adminConnection!);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"DROP DATABASE {QuotedTestDatabase()} WITH (FORCE)", connection);
        await command.ExecuteNonQueryAsync();
        created = false;
    }

    private string QuotedTestDatabase()
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(databaseName, "^lueftlotse_test_[0-9a-f]{32}$"))
            throw new InvalidOperationException("Refusing to operate on a non-test database.");
        return new NpgsqlCommandBuilder().QuoteIdentifier(databaseName);
    }
}
