#include <libnvpair.h>
#include <stdbool.h>

#ifndef	_NVLIST_EQUAL_H
#define	_NVLIST_EQUAL_H

extern bool nvpair_equal(nvpair_t *, nvpair_t *);
extern int nvlist_equal(nvlist_t *, nvlist_t *, bool *);

#endif	/* !_NVLIST_EQUAL_H */
