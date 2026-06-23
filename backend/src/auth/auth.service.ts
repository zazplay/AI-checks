import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { LoginResponseDto } from './dto/login.dto';
import { safeEqual } from './timing-safe';

/**
 * Single demo user, credentials from env (AUTH_USERNAME / AUTH_PASSWORD).
 * A successful login returns a JWT; JwtAuthGuard verifies it on every request.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<LoginResponseDto> {
    const expectedUsername = this.config.get<string>('AUTH_USERNAME');
    const expectedPassword = this.config.get<string>('AUTH_PASSWORD');

    if (!expectedPassword) {
      throw new BadRequestException(
        'Authentication is disabled on this server (AUTH_PASSWORD is not set).',
      );
    }

    const valid =
      !!expectedUsername &&
      safeEqual(username, expectedUsername) &&
      safeEqual(password, expectedPassword);
    if (!valid) {
      throw new UnauthorizedException('Invalid username or password');
    }

    return { accessToken: await this.jwt.signAsync({ sub: username }) };
  }
}
