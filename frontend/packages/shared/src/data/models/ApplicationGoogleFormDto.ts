import { z } from 'zod'
import type { ApplicationGoogleForm } from '../../domain/entities/ApplicationGoogleForm'

const choiceKinds = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'DROPDOWN']

/** 미리 채운 링크를 열 주소이므로 구글 설문 응답 화면(docs.google.com의 viewform)만 받습니다. */
const responderUrl = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'docs.google.com' && !url.username && !url.password && !url.port
      && /^\/forms\/(u\/\d+\/)?d\/(e\/)?[A-Za-z0-9_-]+\/viewform$/.test(url.pathname) && !url.search && !url.hash
  } catch {
    return false
  }
})

export const applicationGoogleFormSchema: z.ZodType<ApplicationGoogleForm> = z.object({
  responderUrl,
  title: z.string().min(1),
  questions: z.array(z.object({
    entryId: z.string().regex(/^\d{1,20}$/).nullable(),
    label: z.string().min(1),
    description: z.string(),
    required: z.boolean(),
    kind: z.enum(['SHORT_TEXT', 'LONG_TEXT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'DROPDOWN', 'UNSUPPORTED']),
    options: z.array(z.string().min(1)),
    allowsOther: z.boolean(),
  }).refine((question) => (question.kind === 'UNSUPPORTED') === (question.entryId === null)
    && choiceKinds.includes(question.kind) === question.options.length > 0
    && (!question.allowsOther || question.kind === 'SINGLE_CHOICE' || question.kind === 'MULTI_CHOICE'))).min(1),
}).refine((form) => {
  const entries = form.questions.flatMap((question) => question.entryId ? [question.entryId] : [])
  return new Set(entries).size === entries.length
}, { message: '구글 설문 문항 번호가 중복됩니다.' })
