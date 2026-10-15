using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Lueftlotse.Api.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialMeasurements : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "measurements",
                columns: table => new
                {
                    measurement_id = table.Column<Guid>(type: "uuid", nullable: false),
                    device_id = table.Column<Guid>(type: "uuid", nullable: false),
                    source = table.Column<string>(type: "text", nullable: false),
                    measured_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ppm = table.Column<int>(type: "integer", nullable: false),
                    segment = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    received_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_measurements", x => x.measurement_id);
                    table.CheckConstraint("ck_measurements_ppm", "ppm BETWEEN 1 AND 100000");
                    table.CheckConstraint("ck_measurements_segment", "char_length(segment) BETWEEN 1 AND 80 AND btrim(segment) <> ''");
                    table.CheckConstraint("ck_measurements_source", "source IN ('simulator', 'sensor')");
                });

            migrationBuilder.CreateIndex(
                name: "ix_measurements_device_id_measured_at",
                table: "measurements",
                columns: new[] { "device_id", "measured_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "measurements");
        }
    }
}
