#ifndef	_UTILS_H
#define	_UTILS_H

typedef struct verror verror_t;

extern void sleep_ms(int ms);
extern void *safe_zalloc(size_t sz);
extern int parse_long(const char *input, long *output, int base);

extern int verror_create(verror_t **vep, const char *format, ...);
extern void verror_cause_set(verror_t *ve, verror_t *cause);
extern verror_t *verror_cause(verror_t *ve);
extern void verror_free(verror_t *ve);

#endif	/* !_UTILS_H */
