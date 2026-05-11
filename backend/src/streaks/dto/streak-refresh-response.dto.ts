import { ApiProperty } from '@nestjs/swagger';

export class StreakRefreshResponse {
  @ApiProperty({ description: 'Current consecutive-day streak after refresh' })
  currentStreak: number;

  @ApiProperty({ description: 'All-time longest streak' })
  longestStreak: number;

  @ApiProperty({
    description:
      'True if a Hackatime refresh fired this call; false if rate-limited.',
  })
  refreshed: boolean;
}
