import { z } from 'zod'

export const planCodeSchema = z.enum(['FREE', 'PLUS', 'PREMIUM'])

/** 현재 요금제입니다. 로그인하지 않았으면 plan이 null입니다. 서버가 나중에 더하는 필드는 읽지 않고 넘깁니다. */
export const planUsageSchema = z.object({
  plan: planCodeSchema.nullable(),
})
