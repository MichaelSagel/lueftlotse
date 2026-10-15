using Microsoft.EntityFrameworkCore;

namespace Lueftlotse.Api.Data;

public sealed class LueftlotseDbContext(DbContextOptions<LueftlotseDbContext> options)
    : DbContext(options);
