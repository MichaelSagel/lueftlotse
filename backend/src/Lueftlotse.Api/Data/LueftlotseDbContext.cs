using Lueftlotse.Api.Features.Measurements;
using Microsoft.EntityFrameworkCore;

namespace Lueftlotse.Api.Data;

public sealed class LueftlotseDbContext(DbContextOptions<LueftlotseDbContext> options) : DbContext(options)
{
    public DbSet<Measurement> Measurements => Set<Measurement>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.ApplyConfiguration(new MeasurementConfiguration());
}
