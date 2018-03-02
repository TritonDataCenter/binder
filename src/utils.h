#ifndef	_UTILS_H
#define	_UTILS_H

/*
 * It would appear that some of these definitions in "sys/time.h" have not
 * existed for as long as we would like.  For now, replicate them here if the
 * system does not provide them.
 */
#ifndef	SEC
#define	SEC				1
#endif
#ifndef	MILLISEC
#define	MILLISEC			1000
#endif
#ifndef	NANOSEC
#define	NANOSEC				1000000000LL
#endif
#ifndef	SEC2NSEC
#define	SEC2NSEC(m)			((hrtime_t)(m) * (NANOSEC / SEC))
#endif
#ifndef	MSEC2NSEC
#define	MSEC2NSEC(m)			((hrtime_t)(m) * (NANOSEC / MILLISEC))
#endif

typedef struct verror verror_t;

extern void sleep_ms(int ms);
extern void *safe_zalloc(size_t sz);
extern int parse_long(const char *input, long *output, int base);

extern int verror_create(verror_t **vep, const char *format, ...);
extern void verror_cause_set(verror_t *ve, verror_t *cause);
extern verror_t *verror_cause(verror_t *ve);
extern void verror_free(verror_t *ve);

#endif	/* !_UTILS_H */
