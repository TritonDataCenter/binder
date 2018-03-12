/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

#include <sys/debug.h>
#include <string.h>
#include "nvlist_equal.h"

#define	COMPARE_BASIC_TYPE(a, b, load, type)				\
	do {								\
		type av, bv;						\
									\
		VERIFY0(load(a, &av));					\
		VERIFY0(load(b, &bv));					\
									\
		return (av == bv);					\
	} while (0)

#define	COMPARE_BASIC_ARRAY(a, b, load, type)				\
	do {								\
		type *av, *bv;						\
		uint_t an, bn;						\
									\
		VERIFY0(load(a, &av, &an));				\
		VERIFY0(load(b, &bv, &bn));				\
									\
		if (an != bn) {						\
			return (false);					\
		}							\
									\
		for (uint_t i = 0; i < an; i++) {			\
			if (av[i] != bv[i]) {				\
				return (false);				\
			}						\
		}							\
									\
		return (true);						\
	} while (0)

bool
nvpair_equal(nvpair_t *a, nvpair_t *b)
{
	if (nvpair_type(a) != nvpair_type(b)) {
		return (false);
	}

	switch (nvpair_type(a)) {
	case DATA_TYPE_NVLIST: {
		nvlist_t *av, *bv;

		VERIFY0(nvpair_value_nvlist(a, &av));
		VERIFY0(nvpair_value_nvlist(b, &bv));

		/*
		 * XXX This will abort if the nested nvlists were not allocated
		 * with NV_UNIQUE_NAME.
		 */
		bool equal;
		VERIFY0(nvlist_equal(av, bv, &equal));

		return (equal);
	}

	case DATA_TYPE_NVLIST_ARRAY: {
		nvlist_t **av, **bv;
		uint_t an, bn;

		VERIFY0(nvpair_value_nvlist_array(a, &av, &an));
		VERIFY0(nvpair_value_nvlist_array(b, &bv, &bn));

		if (an != bn) {
			return (false);
		}

		for (uint_t i = 0; i < an; i++) {
			/*
			 * XXX This will abort if the nested nvlists were not
			 * allocated with NV_UNIQUE_NAME.
			 */
			bool equal;
			VERIFY0(nvlist_equal(av[i], bv[i], &equal));

			if (!equal) {
				return (false);
			}
		}

		return (true);
	}

	case DATA_TYPE_BOOLEAN: {
		/*
		 * The "boolean" data type in the nvlist interface amounts to
		 * what simply must be an accident of history.  Properties of
		 * this type have no value, so the mere existence of a property
		 * in both lists with this type and the same name effectively
		 * represents equality.
		 */
		return (true);
	}

	case DATA_TYPE_BOOLEAN_VALUE: {
		boolean_t av, bv;

		VERIFY0(nvpair_value_boolean_value(a, &av));
		VERIFY0(nvpair_value_boolean_value(b, &bv));
		VERIFY(av == B_TRUE || av == B_FALSE);
		VERIFY(bv == B_TRUE || bv == B_FALSE);

		return (av == bv);
	}

	case DATA_TYPE_BOOLEAN_ARRAY: {
		boolean_t *av, *bv;
		uint_t an, bn;

		VERIFY0(nvpair_value_boolean_array(a, &av, &an));
		VERIFY0(nvpair_value_boolean_array(b, &bv, &bn));

		if (an != bn) {
			return (false);
		}

		for (uint_t i = 0; i < an; i++) {
			VERIFY(av[i] == B_TRUE || av[i] == B_FALSE);
			VERIFY(bv[i] == B_TRUE || bv[i] == B_FALSE);

			if (av[i] != bv[i]) {
				return (false);
			}
		}

		return (true);
	}

	case DATA_TYPE_STRING: {
		char *av, *bv;

		VERIFY0(nvpair_value_string(a, &av));
		VERIFY0(nvpair_value_string(b, &bv));

		return (strcmp(av, bv) == 0);
	}

	case DATA_TYPE_STRING_ARRAY: {
		char **av, **bv;
		uint_t an, bn;

		VERIFY0(nvpair_value_string_array(a, &av, &an));
		VERIFY0(nvpair_value_string_array(b, &bv, &bn));

		if (an != bn) {
			return (false);
		}

		for (uint_t i = 0; i < an; i++) {
			if (strcmp(av[i], bv[i]) != 0) {
				return (false);
			}
		}

		return (true);
	}

	case DATA_TYPE_BYTE:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_byte, uchar_t);
		break;

	case DATA_TYPE_BYTE_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_byte_array, uchar_t);
		break;

	case DATA_TYPE_INT8:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_int8, int8_t);
		break;

	case DATA_TYPE_INT8_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_int8_array, int8_t);
		break;

	case DATA_TYPE_UINT8:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_uint8, uint8_t);
		break;

	case DATA_TYPE_UINT8_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_uint8_array, uint8_t);
		break;

	case DATA_TYPE_INT16:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_int16, int16_t);
		break;

	case DATA_TYPE_INT16_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_int16_array, int16_t);
		break;

	case DATA_TYPE_UINT16:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_uint16, uint16_t);
		break;

	case DATA_TYPE_UINT16_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_uint16_array, uint16_t);
		break;

	case DATA_TYPE_INT32:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_int32, int32_t);
		break;

	case DATA_TYPE_INT32_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_int32_array, int32_t);
		break;

	case DATA_TYPE_UINT32:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_uint32, uint32_t);
		break;

	case DATA_TYPE_UINT32_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_uint32_array, uint32_t);
		break;

	case DATA_TYPE_INT64:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_int64, int64_t);
		break;

	case DATA_TYPE_INT64_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_int64_array, int64_t);
		break;

	case DATA_TYPE_UINT64:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_uint64, uint64_t);
		break;

	case DATA_TYPE_UINT64_ARRAY:
		COMPARE_BASIC_ARRAY(a, b, nvpair_value_uint64_array, uint64_t);
		break;

	case DATA_TYPE_HRTIME:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_hrtime, hrtime_t);
		break;

	case DATA_TYPE_DOUBLE:
		COMPARE_BASIC_TYPE(a, b, nvpair_value_double, double);
		break;

	case DATA_TYPE_UNKNOWN:
		abort();
		break;
	}

	abort();
}

static bool
nvlist_equal_half(nvlist_t *a, nvlist_t *b)
{
	VERIFY3P(a, !=, NULL);
	VERIFY3P(b, !=, NULL);

	for (nvpair_t *ap = nvlist_next_nvpair(a, NULL); ap != NULL;
	    ap = nvlist_next_nvpair(a, ap)) {
		int r;
		nvpair_t *bp;

		if ((r = nvlist_lookup_nvpair(b, nvpair_name(ap), &bp)) != 0) {
			if (r == EINVAL && !nvlist_exists(b, nvpair_name(ap))) {
				/*
				 * There appears to be a bug in
				 * nvlist_lookup_nvpair() causing it to return
				 * EINVAL under some conditions where it should
				 * really return ENOENT.
				 */
				r = ENOENT;
			}
			VERIFY3S(r, ==, ENOENT);

			return (false);
		}

		if (!nvpair_equal(ap, bp)) {
			return (false);
		}
	}

	return (true);
}

/*
 * Deep equality check for two nvlists allocated with NV_UNIQUE_NAME, and using
 * only a limited range of data types (see the case block).
 */
int
nvlist_equal(nvlist_t *a, nvlist_t *b, bool *equal)
{
	*equal = nvlist_equal_half(a, b) && nvlist_equal_half(b, a);

	return (0);
}
