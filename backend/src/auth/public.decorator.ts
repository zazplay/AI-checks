import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as exempt from the global API-key guard (e.g. /health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
