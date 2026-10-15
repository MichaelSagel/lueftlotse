using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Lueftlotse.Api.Features.Measurements;

public sealed class MeasurementConfiguration : IEntityTypeConfiguration<Measurement>
{
    public void Configure(EntityTypeBuilder<Measurement> builder)
    {
        builder.ToTable("measurements", table =>
        {
            table.HasCheckConstraint("ck_measurements_source", "source IN ('simulator', 'sensor')");
            table.HasCheckConstraint("ck_measurements_ppm", "ppm BETWEEN 1 AND 100000");
            table.HasCheckConstraint("ck_measurements_segment", "char_length(segment) BETWEEN 1 AND 80 AND btrim(segment) <> ''");
        });
        builder.HasKey(x => x.MeasurementId).HasName("pk_measurements");
        builder.Property(x => x.MeasurementId).HasColumnName("measurement_id").ValueGeneratedNever();
        builder.Property(x => x.DeviceId).HasColumnName("device_id");
        builder.Property(x => x.Source).HasColumnName("source").IsRequired();
        builder.Property(x => x.MeasuredAt).HasColumnName("measured_at").HasColumnType("timestamp with time zone");
        builder.Property(x => x.Ppm).HasColumnName("ppm");
        builder.Property(x => x.Segment).HasColumnName("segment").HasMaxLength(80).IsRequired();
        builder.Property(x => x.ReceivedAt).HasColumnName("received_at").HasColumnType("timestamp with time zone");
        builder.HasIndex(x => new { x.DeviceId, x.MeasuredAt }).HasDatabaseName("ix_measurements_device_id_measured_at");
    }
}
