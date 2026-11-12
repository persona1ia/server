import { z } from 'zod'

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/)
const mediaIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const titleSchema = z.string().max(200)
const textSchema = z.string().max(20_000)

const urlSchema = z
  .string()
  .max(2048)
  .refine(value => {
    for (const character of value) {
      const code = character.charCodeAt(0)
      if (code <= 32 || code === 127 || character === '\\') {
        return false
      }
    }

    if (value.startsWith('#')) {
      return value.length > 1
    }

    if (value.startsWith('/')) {
      return !value.startsWith('//')
    }

    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Use an HTTP(S) URL, a path starting with /, or an anchor starting with #')

const linkSchema = z.strictObject({
  url: urlSchema,
  label: titleSchema.min(1),
})

const blockFields = {
  id: idSchema,
  title: titleSchema,
  visible: z.boolean(),
}

const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...blockFields,
    text: textSchema,
    type: z.literal('hero'),
    action: linkSchema.nullable(),
    imageId: mediaIdSchema.nullable(),
  }),
  z.strictObject({
    ...blockFields,
    text: textSchema,
    type: z.literal('about'),
    imageId: mediaIdSchema.nullable(),
  }),
  z.strictObject({
    ...blockFields,
    text: textSchema,
    type: z.literal('text'),
  }),
  z.strictObject({
    ...blockFields,
    type: z.literal('courses'),
    courseIds: z.array(idSchema).max(500),
  }),
  z.strictObject({
    ...blockFields,
    type: z.literal('gallery'),
    images: z
      .array(z.strictObject({ alt: titleSchema, imageId: mediaIdSchema }))
      .max(200),
  }),
  z.strictObject({
    ...blockFields,
    type: z.literal('testimonials'),
    items: z
      .array(
        z.strictObject({
          text: textSchema,
          author: titleSchema.min(1),
          imageId: mediaIdSchema.nullable(),
        }),
      )
      .max(200),
  }),
  z.strictObject({
    ...blockFields,
    type: z.literal('faq'),
    items: z
      .array(
        z.strictObject({
          answer: textSchema,
          question: titleSchema.min(1),
        }),
      )
      .max(200),
  }),
  z.strictObject({
    ...blockFields,
    text: textSchema,
    type: z.literal('contacts'),
  }),
])

export const siteContentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    blocks: z.array(blockSchema).max(200),
    site: z.strictObject({
      title: titleSchema,
      description: z.string().max(2000),
      contacts: z.strictObject({
        phone: z.string().max(100),
        address: z.string().max(1000),
        links: z.array(linkSchema).max(50),
        email: z.union([z.literal(''), z.email().max(254)]),
      }),
    }),
    courses: z
      .array(
        z.strictObject({
          id: idSchema,
          visible: z.boolean(),
          description: textSchema,
          title: titleSchema.min(1),
          imageId: mediaIdSchema.nullable(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          priceMinor: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .max(500),
  })
  .superRefine((content, context) => {
    const courseIds = new Set<string>()
    for (const [index, course] of content.courses.entries()) {
      if (courseIds.has(course.id)) {
        context.addIssue({
          code: 'custom',
          path: ['courses', index, 'id'],
          message: 'Course IDs must be unique',
        })
      }
      courseIds.add(course.id)
    }

    const blockIds = new Set<string>()
    for (const [index, block] of content.blocks.entries()) {
      if (blockIds.has(block.id)) {
        context.addIssue({
          code: 'custom',
          path: ['blocks', index, 'id'],
          message: 'Block IDs must be unique',
        })
      }
      blockIds.add(block.id)

      if (block.type === 'courses') {
        const referencedIds = new Set<string>()
        for (const [referenceIndex, courseId] of block.courseIds.entries()) {
          if (!courseIds.has(courseId) || referencedIds.has(courseId)) {
            context.addIssue({
              code: 'custom',
              path: ['blocks', index, 'courseIds', referenceIndex],
              message:
                'Course references must exist and must not repeat within a block',
            })
          }
          referencedIds.add(courseId)
        }
      }
    }
  })
