/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * SMF_ADJUST
 *
 * This tool configures a set of service instances for an existing SMF service.
 * Each instance will have several properties in the "config" property based on
 * the instance number, which are used to populate arguments in the
 * "exec_method" configuration at the service level.
 *
 * This tool is idempotent, and attempts to avoid disruption to running
 * instances if no reconfiguration is required.
 */

#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>
#include <err.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <limits.h>
#include <sys/avl.h>
#include <sys/debug.h>
#include <libnvpair.h>
#include <libscf.h>

#include "smfx.h"
#include "utils.h"
#include "nvlist_equal.h"



#define	BINDER_SOCKET_PATH	"/var/run/binder/sockets/%ld"

#define	SCF_SNAPSHOT_RUNNING	"running"

static int nvlist_to_pg(scf_propertygroup_t *pg, nvlist_t *targ);
static int pg_to_nvlist(scf_propertygroup_t *pg, nvlist_t **nvlp);

static ssize_t max_scf_fmri_size;
static ssize_t max_scf_name_size;
static ssize_t max_scf_pg_type_size;
static ssize_t max_scf_value_size;

/*
 * "inst_t" objects describe SMF service instances of one of two types: those
 * intended to exist as part of the instance creation plan, and those which
 * _do_ exist on the system but need to be removed.  These objects are tracked
 * in the "g_insts" AVL tree, indexed by "inst_name".
 */
typedef struct inst {
	/*
	 * The short name of the instance, as one might pass to
	 * "scf_service_get_instance(3SCF)".
	 */
	char *inst_name;

	/*
	 * If the service instance is intended to exist as part of the instance
	 * creation plan, "inst_needed" will be set true and the service will
	 * be created or configured if necessary.  If the instance is found
	 * during the initial instance walk, but should _not_ exist, this is
	 * set false and the service is subsequently removed.  Instances that
	 * are not part of the creation plan will not have a valid value for
	 * "inst_number".
	 */
	bool inst_needed;
	long inst_number;

	/*
	 * Storage of intermediate handles and data for calls to libscf(3LIB).
	 */
	scf_instance_t *inst_instance;
	char *inst_fmri;

	/*
	 * If the service instance is found during the initial walk, this is
	 * set to true.  It is also updated as services are created or removed.
	 */
	bool inst_exists;

	/*
	 * Linkage for "g_insts" AVL tree.
	 */
	avl_node_t inst_node;
} inst_t;

/*
 * A map from "inst_name" to an "inst_t" object.  Uses the "insts_compar"
 * comparator.
 */
avl_tree_t g_insts;

static int
insts_compar(const void *first, const void *second)
{
	const inst_t *finst = first;
	const inst_t *sinst = second;

	int ret = strcmp(finst->inst_name, sinst->inst_name);

	return (ret > 0 ? 1 : ret < 0 ? -1 : 0);
}

static int
insts_add_common(const char *name, const char *base, unsigned idx, bool needed)
{
	inst_t *inst;

	if ((inst = calloc(1, sizeof (*inst))) == NULL) {
		return (-1);
	}

	if (name != NULL) {
		if ((inst->inst_name = strdup(name)) == NULL) {
			free(inst);
			return (-1);
		}
	} else {
		if (asprintf(&inst->inst_name, "%s-%u", base, idx) < 0) {
			free(inst);
			return (-1);
		}
	}

	inst->inst_number = idx;
	inst->inst_needed = needed;

	avl_add(&g_insts, inst);

	return (0);
}

static int
insts_add_planned(const char *base, unsigned idx)
{
	return (insts_add_common(NULL, base, idx, true));
}

static int
insts_add_unwanted(const char *name)
{
	return (insts_add_common(name, NULL, 0, false));
}

static inst_t *
insts_lookup(const char *name)
{
	inst_t search;

	search.inst_name = (char *)name;

	return (avl_find(&g_insts, &search, NULL));
}

static int
configure_scf(void)
{
	max_scf_fmri_size = scf_limit(SCF_LIMIT_MAX_FMRI_LENGTH) + 1;
	max_scf_name_size = scf_limit(SCF_LIMIT_MAX_NAME_LENGTH) + 1;
	max_scf_pg_type_size = scf_limit(SCF_LIMIT_MAX_PG_TYPE_LENGTH) + 1;
	max_scf_value_size = scf_limit(SCF_LIMIT_MAX_VALUE_LENGTH) + 1;

	if (max_scf_fmri_size < 1 || max_scf_name_size < 1 ||
	    max_scf_pg_type_size < 1 || max_scf_value_size < 1) {
		errx(1, "sizes are not > 0");
	}

	return (0);
}

static void
fatal_scf(const char *name)
{
	errx(1, "%s: %s", name, scf_strerror(scf_error()));
}

static int
remove_instance(smfx_t *smfx, scf_service_t *service, const char *name)
{
	scf_instance_t *i;
	if (smfx_load_instance(smfx, service, name, &i) != 0) {
		errno = EINVAL;
		return (-1);
	}

	/*
	 * Determine the full FMRI for this instance.
	 */
	char *fmri;
	if (smfx_instance_fmri(smfx, i, &fmri) != 0) {
		scf_instance_destroy(i);
		errno = EINVAL;
		return (-1);
	}

	/*
	 * First we need to make sure the instance is not running.
	 */
	for (;;) {
		char *st;

		if ((st = smf_get_state(fmri)) == NULL) {
			if (scf_error() == SCF_ERROR_NOT_FOUND) {
				/*
				 * Could it be that the service has never
				 * been started!
				 */
				(void) smf_disable_instance(fmri, 0);
				goto wait;
			}
			fatal_scf("smf_get_state");
		}

		printf("remove_instance: %s in state \"%s\"\n", fmri, st);

		if (strcmp(st, SCF_STATE_STRING_DISABLED) == 0 ||
		    strcmp(st, SCF_STATE_STRING_MAINT) == 0) {
			printf("\tservice is offline\n");
			break;
		}

		/*
		 * This service is neither disabled, nor in the
		 * maintenance state.  Try to disable it.
		 */
		printf("\tdisabling...\n");
		if (smf_disable_instance(fmri, 0) != 0) {
			fatal_scf("smf_disable_instance");
		}

wait:
		sleep_ms(100);
	}

	/*
	 * Now that the instance is not online, delete it.
	 */
	if (scf_instance_delete(i) != 0) {
		fatal_scf("scf_instance_delete");
	}

	scf_instance_destroy(i);
	free(fmri);
	return (0);
}

static int
nvpair_to_value(nvpair_t *nvp, scf_value_t *value, scf_type_t *typep)
{
	scf_type_t type;

	switch (nvpair_type(nvp)) {
	case DATA_TYPE_STRING: {
		char *val;

		VERIFY0(nvpair_value_string(nvp, &val));

		if (scf_value_set_astring(value, val) != 0) {
			fatal_scf("scf_value_set_astring");
		}
		type = SCF_TYPE_ASTRING;
		break;
	}

	case DATA_TYPE_BOOLEAN_VALUE: {
		boolean_t val;

		VERIFY0(nvpair_value_boolean_value(nvp, &val));

		scf_value_set_boolean(value, val ? 1 : 0);
		type = SCF_TYPE_BOOLEAN;
		break;
	}

	case DATA_TYPE_INT64: {
		int64_t val;

		VERIFY0(nvpair_value_int64(nvp, &val));

		scf_value_set_integer(value, val);
		type = SCF_TYPE_INTEGER;
		break;
	}

	case DATA_TYPE_UINT64: {
		uint64_t val;

		VERIFY0(nvpair_value_uint64(nvp, &val));

		scf_value_set_count(value, val);
		type = SCF_TYPE_COUNT;
		break;
	}

	default:
		/*
		 * Unsupported value type.
		 */
		VERIFY(!"unsupported value type");
	}

	if (typep != NULL) {
		*typep = type;
	}
	return (0);
}

static int
refresh_instance(smfx_t *smfx, scf_instance_t *i)
{
	char *fmri;
	if (smfx_instance_fmri(smfx, i, &fmri) != 0) {
		scf_instance_destroy(i);
		return (-1);
	}

	if (smf_refresh_instance(fmri) != 0) {
		fatal_scf("smf_refresh_instance");
	}

	free(fmri);
	return (0);
}

static int
configure_instance(smfx_t *smfx, scf_instance_t *i, nvlist_t *targ)
{
	scf_handle_t *scf = scf_instance_handle(i);
	nvlist_t *current = NULL, *fromsnap = NULL;
	scf_propertygroup_t *pg = NULL, *cpg = NULL;

	/*
	 * Ensure that the property group exists and obtain a reference to it.
	 */
	if (smfx_ensure_pg(smfx, i, &pg, "config", SCF_GROUP_APPLICATION) !=
	    0) {
		errno = EINVAL;
		return (-1);
	}

	/*
	 * First, determine whether we need to make an update at all.  Check
	 * to see if the current contents of the property group match our
	 * desired contents.
	 */
	if (pg_to_nvlist(pg, &current) != 0) {
		err(1, "pg_to_nvlist");
	}

	bool no_update;
	if (nvlist_equal(current, targ, &no_update) != 0) {
		err(1, "nvlist_equal");
	}

	if (no_update) {
		printf("\t\tno update to pg required!\n");
	} else {
		printf("\t\tupdating pg from:\n");
		dump_nvlist(current, 24);
		printf("\t\t... to:\n");
		dump_nvlist(targ, 24);
		printf("\n");

		if (nvlist_to_pg(pg, targ) != 0) {
			err(1, "nvlist_to_pg");
		}
	}

	bool refresh = false;
	scf_snapshot_t *snap = NULL;

	if (smfx_load_snapshot(smfx, i, SCF_SNAPSHOT_RUNNING, &snap) != 0) {
		if (smfx_scf_error(smfx) != SCF_ERROR_NOT_FOUND) {
			errx(1, "loading running snapshot: %s",
			    smfx_errmsg(smfx));
		}

		printf("\t\tsnapshot \"%s\" not found\n",
		    SCF_SNAPSHOT_RUNNING);

		refresh = true;
		goto refresh;
	}

	if ((cpg = scf_pg_create(scf)) == NULL) {
		fatal_scf("scf_pg_create");
	}

	/*
	 * We were able to find the "running" snapshot for this instance.
	 * Let's load the contents of the "config" property group so that we
	 * can determine if a refresh is required.
	 */
	if (scf_instance_get_pg_composed(i, snap, "config", cpg) != 0) {
		if (scf_error() == SCF_ERROR_NOT_FOUND) {
			/*
			 * The property group does not appear in the
			 * running snapshot at all.
			 */
			printf("\t\t\t\"config\" not in snapshot\n");
			refresh = true;
			goto refresh;
		}

		fatal_scf("scf_instance_get_pg_composed");
	}

	if (pg_to_nvlist(cpg, &fromsnap) != 0) {
		err(1, "pg_to_nvlist (fromsnap)");
	}

	bool snapeq;
	if (nvlist_equal(targ, fromsnap, &snapeq) != 0) {
		err(1, "nvlist_equal (targ, fromsnap)");
	}

	if (!snapeq) {
		printf("\t\tin snapshot, \"config\" exists:\n");
		dump_nvlist(fromsnap, 24);
		printf("\t\t... but needs to be:\n");
		dump_nvlist(targ, 24);
		printf("\n");

		refresh = true;
		goto refresh;
	}

refresh:
	if (refresh) {
		printf("\t\trefreshing...\n");
		if (refresh_instance(smfx, i) != 0) {
			warn("refreshing instance: %s", smfx_errmsg(smfx));
		}
	} else {
		printf("\t\tno refresh required\n");
	}

	nvlist_free(current);
	nvlist_free(fromsnap);
	scf_pg_destroy(pg);
	scf_pg_destroy(cpg);
	return (0);
}

static int
enable_instance(smfx_t *smfx, scf_instance_t *i, bool wait_for_online)
{
	char *fmri;
	if (smfx_instance_fmri(smfx, i, &fmri) != 0) {
		errno = EINVAL;
		return (-1);
	}

	hrtime_t start = gethrtime();

	char *st = NULL;
again:
	free(st);
	if ((st = smf_get_state(fmri)) == NULL) {
		fatal_scf("smf_get_state");
	}

	if (strcmp(st, SCF_STATE_STRING_ONLINE) == 0) {
		/*
		 * The service is already online; no action is required.
		 */
		goto done;
	}

	if (strcmp(st, SCF_STATE_STRING_MAINT) == 0 ||
	    strcmp(st, SCF_STATE_STRING_DEGRADED) == 0) {
		/*
		 * The service is in the maintenance or degraded state.
		 * Attempt to clear this state.
		 */
		if (smf_restore_instance(fmri) != 0) {
			fatal_scf("smf_restore_instance");
		}

		goto wait;
	}

	if (strcmp(st, SCF_STATE_STRING_DISABLED) == 0 ||
	    strcmp(st, SCF_STATE_STRING_UNINIT) == 0) {
		/*
		 * The service is disabled or has not yet been seen by
		 * svc.startd.  Refresh the instance to ensure visibility of
		 * the latest property group changes, and then enable the
		 * instance.
		 */
		if (smf_refresh_instance(fmri) != 0) {
			fatal_scf("smf_restore_instance");
		}
		if (smf_enable_instance(fmri, 0) != 0) {
			fatal_scf("smf_restore_instance");
		}

		goto wait;
	}

	/*
	 * The service is otherwise in an intermediate state and we do not
	 * have a remedial action to take.
	 */
	if (!wait_for_online) {
		printf("WARNING: not waiting, but \"%s\" in state \"%s\"\n",
		    fmri, st);
	}

wait:
	if (wait_for_online) {
		/*
		 * Don't wait more than 60 seconds for this situation to correct
		 * itself.
		 */
		hrtime_t duration = gethrtime() - start;
		if (duration > SEC2NSEC(60)) {
			free(fmri);
			free(st);
			errno = ETIMEDOUT;
			return (-1);
		}

		sleep_ms(100);
		goto again;
	}

done:
	free(fmri);
	free(st);
	return (0);
}

/*
 * Create an nvlist which contains the properties from a property group.
 */
static int
pg_to_nvlist(scf_propertygroup_t *pg, nvlist_t **nvlp)
{
	int e;
	nvlist_t *nvl = NULL;
	char *n = NULL, *sv = NULL;
	scf_handle_t *scf = scf_pg_handle(pg);

	*nvlp = NULL;

	if ((e = nvlist_alloc(&nvl, NV_UNIQUE_NAME, 0)) != 0) {
		goto fail;
	}

	if ((n = malloc(max_scf_name_size)) == NULL ||
	    (sv = malloc(max_scf_value_size)) == NULL) {
		e = errno;
		goto fail;
	}

	/*
	 * Allocate iterator objects.
	 */
	scf_iter_t *itp = NULL, *itv = NULL;
	if ((itp = scf_iter_create(scf)) == NULL ||
	    (itv = scf_iter_create(scf)) == NULL) {
		fatal_scf("scf_iter_create");
	}
	scf_property_t *prop = NULL;
	if ((prop = scf_property_create(scf)) == NULL) {
		fatal_scf("scf_property_create");
	}
	scf_value_t *value = NULL;
	if ((value = scf_value_create(scf)) == NULL) {
		fatal_scf("scf_value_create");
	}

	/*
	 * Walk the properties in the specified property group so that we
	 * can construct an nvlist with the values we find.
	 */
	if (scf_iter_pg_properties(itp, pg) != 0) {
		fatal_scf("scf_iter_pg_properties");
	}

	for (;;) {
		int r;
		if ((r = scf_iter_next_property(itp, prop)) < 0) {
			fatal_scf("scf_iter_next_property");
		} else if (r == 0) {
			/*
			 * No more properties.
			 */
			break;
		}
		VERIFY3S(r, ==, 1);

		n[0] = '\0';
		if (scf_property_get_name(prop, n, max_scf_name_size) < 0) {
			fatal_scf("scf_pg_get_name");
		}

		/*
		 * Walk each of the values for this property.  Note that we
		 * only want one value per property at this time; multi-valued
		 * properties will result in an error.
		 */
		scf_iter_reset(itv);
		if (scf_iter_property_values(itv, prop) != 0) {
			fatal_scf("scf_iter_property_values");
		}

		for (;;) {
			if ((r = scf_iter_next_value(itv, value)) < 0) {
				fatal_scf("scf_iter_next_value");
			} else if (r == 0) {
				/*
				 * No more values.
				 */
				break;
			}
			VERIFY3S(r, ==, 1);

			if (nvlist_exists(nvl, n)) {
				warnx("property \"%s\" has more than one "
				    "value", n);
				e = EPROTO;
				goto fail;
			}

			switch (scf_value_type(value)) {
			case SCF_TYPE_ASTRING: {
				sv[0] = '\0';
				if (scf_value_get_astring(value, sv,
				    max_scf_value_size) < 0) {
					fatal_scf("scf_value_get_astring");
				}

				if ((e = nvlist_add_string(nvl, n, sv)) != 0) {
					goto fail;
				}

				break;
			}

			case SCF_TYPE_BOOLEAN: {
				uint8_t out;

				if (scf_value_get_boolean(value, &out) != 0) {
					fatal_scf("scf_value_get_boolean");
				}

				if ((e = nvlist_add_boolean_value(nvl, n, out ?
				    B_TRUE : B_FALSE)) != 0) {
					goto fail;
				}

				break;
			}

			case SCF_TYPE_COUNT: {
				uint64_t out;

				if (scf_value_get_count(value, &out) != 0) {
					fatal_scf("scf_value_get_count");
				}

				if ((e = nvlist_add_uint64(nvl, n, out)) != 0) {
					goto fail;
				}

				break;
			}

			case SCF_TYPE_INTEGER: {
				int64_t out;

				if (scf_value_get_integer(value, &out) != 0) {
					fatal_scf("scf_value_get_integer");
				}

				if ((e = nvlist_add_int64(nvl, n, out)) != 0) {
					goto fail;
				}

				break;
			}

			default:
				warnx("invalid type for property \"%s\"", n);
				e = EPROTO;
				goto fail;
			}
		}
	}

fail:
	scf_property_destroy(prop);
	scf_value_destroy(value);
	scf_iter_destroy(itp);
	scf_iter_destroy(itv);
	free(n);
	free(sv);
	if (e == 0) {
		*nvlp = nvl;
		return (0);
	} else {
		nvlist_free(nvl);

		errno = e;
		return (-1);
	}
}

/*
 * Update a property group so that its contents exactly match the contents we
 * get from this nvlist.
 */
static int
nvlist_to_pg(scf_propertygroup_t *pg, nvlist_t *targ)
{
	scf_handle_t *scf = scf_pg_handle(pg);

	/*
	 * First, load a view of the current property group into an nvlist,
	 * as they are easier to work with.
	 */
	nvlist_t *cur;
	if (pg_to_nvlist(pg, &cur) != 0) {
		return (-1);
	}

	/*
	 * Allocate and start a transaction in case we need to make changes
	 * to the property group.
	 */
	bool dirty = false;
	scf_transaction_t *txn;
	if ((txn = scf_transaction_create(scf)) == NULL) {
		fatal_scf("scf_transaction_create");
	}
	if (scf_transaction_start(txn, pg) != 0) {
		fatal_scf("scf_transaction_start");
	}

	/*
	 * Using the current nvlist, check to see if there are any properties
	 * which do not exist in the target nvlist.  These properties will need
	 * to be removed from the property group.
	 */
	for (nvpair_t *nvp = nvlist_next_nvpair(cur, NULL); nvp != NULL;
	    nvp = nvlist_next_nvpair(cur, nvp)) {
		if (nvlist_exists(targ, nvpair_name(nvp))) {
			continue;
		}

		scf_transaction_entry_t *entry;
		if ((entry = scf_entry_create(scf)) == NULL) {
			fatal_scf("scf_entry_create");
		}

		dirty = true;
		if (scf_transaction_property_delete(txn, entry,
		    nvpair_name(nvp)) != 0) {
			fatal_scf("scf_transaction_property_delete");
		}
	}

	/*
	 * Now that we have arranged to remove any properties that are in the
	 * current list but not in the target list, we can do one pass through
	 * the target list and check to see if we need to add or update any
	 * properties.
	 */
	for (nvpair_t *nvp = nvlist_next_nvpair(targ, NULL); nvp != NULL;
	    nvp = nvlist_next_nvpair(targ, nvp)) {
		/*
		 * Allocate the objects required to update a property.
		 */
		scf_transaction_entry_t *entry;
		if ((entry = scf_entry_create(scf)) == NULL) {
			fatal_scf("scf_entry_create");
		}
		scf_value_t *value;
		if ((value = scf_value_create(scf)) == NULL) {
			fatal_scf("scf_value_create");
		}

		scf_type_t type;
		if (nvpair_to_value(nvp, value, &type) != 0) {
			err(1, "nvpair_to_value");
		}

		if (!nvlist_exists(cur, nvpair_name(nvp))) {
			/*
			 * Add a new property to the property group.
			 */
			dirty = true;
			if (scf_transaction_property_new(txn, entry,
			    nvpair_name(nvp), type) != 0) {
				fatal_scf("scf_transaction_property_new");
			}

			if (scf_entry_add_value(entry, value) != 0) {
				fatal_scf("scf_entry_add_value");
			}
			continue;
		}

		nvpair_t *curnvp;
		VERIFY0(nvlist_lookup_nvpair(cur, nvpair_name(nvp), &curnvp));

		if (nvpair_equal(nvp, curnvp)) {
			/*
			 * The property exists already, and the target value
			 * matches the current value.
			 */
			scf_value_destroy(value);
			scf_entry_destroy(entry);
			continue;
		}

		/*
		 * The property exists already, but does not have the correct
		 * value.
		 */
		dirty = true;
		if (scf_transaction_property_change_type(txn, entry,
		    nvpair_name(nvp), type) != 0) {
			fatal_scf("scf_transaction_property_change_type");
		}

		if (scf_entry_add_value(entry, value) != 0) {
			fatal_scf("scf_entry_add_value");
		}
	}

	if (dirty) {
		int r;

		if ((r = scf_transaction_commit(txn)) < 0) {
			fatal_scf("scf_transaction_commit");
		} else if (r == 0) {
			/*
			 * XXX What to do with a concurrent modification,
			 * early in the morning?
			 */
			abort();
		}
		VERIFY3S(r, ==, 1);
	}
	scf_transaction_destroy_children(txn);
	scf_transaction_destroy(txn);
	nvlist_free(cur);
	return (0);
}

int
main(int argc, char *argv[])
{
	int c;
	const char *base = NULL;
	const char *sfmri = NULL;
	const char *restart_ifmri = NULL;
	long instance_count = 1;
	long base_number = 1;
	smfx_t *smfx = NULL;
	char smfx_msg[SMFX_ERROR_SIZE];
	bool wait_for_start = false;

	/*
	 * We would like each line emitted by printf(3C) to appear promptly in
	 * the log file that this command is generally redirected to.
	 */
	(void) setlinebuf(stdout);

	while ((c = getopt(argc, argv, ":B:b:i:s:r:w")) != -1) {
		switch (c) {
		case 'B':
			if (parse_long(optarg, &base_number, 10) != 0 ||
			    base_number < 0 || base_number > 65535) {
				err(1, "-%c requires integer from 0 to 65535",
				    optopt);
			}
			break;

		case 'b':
			base = optarg;
			break;

		case 's':
			sfmri = optarg;
			break;

		case 'i':
			if (parse_long(optarg, &instance_count, 10) != 0 ||
			    instance_count < 0 || instance_count > 32) {
				err(1, "-%c requires integer from 0 to 32",
				    optopt);
			}
			break;

		case 'r':
			restart_ifmri = optarg;
			break;

		case 'w':
			wait_for_start = true;
			break;

		case ':':
			errx(1, "Option -%c requires an operand", optopt);
			break;

		default:
			VERIFY3S(c, ==, '?');
			errx(1, "Unrecognised option: -%c", optopt);
			break;
		}
	}

	if (sfmri == NULL) {
		errx(1, "Must provide service FMRI (-s)");
	}

	if (base == NULL) {
		errx(1, "Must provide base instance name (-b)");
	}

	if (configure_scf() != 0) {
		return (1);
	}

	if (smfx_alloc(&smfx, smfx_msg) != 0) {
		errx(1, "smfx_alloc: %s", smfx_msg);
	}

	scf_service_t *service = NULL;
	if (smfx_locate_service(smfx, sfmri, &service) != 0) {
		errx(1, "could not locate service: %s", smfx_errmsg(smfx));
	}

	char *sn = safe_zalloc(max_scf_name_size);
	if (scf_service_get_name(service, sn, max_scf_name_size) < 0) {
		fatal_scf("scf_service_get_name");
	}

	printf("service name: %s\n", sn);
	free(sn);

	/*
	 * Generate the list of expected instances.
	 */
	avl_create(&g_insts, insts_compar, sizeof (inst_t), offsetof(inst_t,
	    inst_node));

	for (unsigned k = 0; k < (unsigned)instance_count; k++) {
		if (insts_add_planned(base, k + base_number) != 0) {
			err(1, "insts_add_planned");
		}
	}

	/*
	 * Get the list of instances which currently exist in the system.
	 */
	char *ina = safe_zalloc(max_scf_name_size);
	scf_instance_t *instance = NULL;
	if (smfx_instance_create(smfx, &instance) != 0) {
		errx(1, "listing instances: %s", smfx_errmsg(smfx));
	}

	scf_iter_t *i_instance;
	if ((i_instance = scf_iter_create(smfx_handle(smfx))) == NULL) {
		fatal_scf("scf_iter_create (instance)");
	}

	if (scf_iter_service_instances(i_instance, service) != 0) {
		fatal_scf("scf_iter_service_instances");
	}
	for (unsigned j = 0; ; j++) {
		int q;

		if ((q = scf_iter_next_instance(i_instance, instance)) < 0) {
			fatal_scf("scf_iter_next_instance");
		} else if (q == 0) {
			break;
		}
		VERIFY3S(q, ==, 1);

		if (scf_instance_get_name(instance, ina,
		    max_scf_name_size) < 0) {
			fatal_scf("scf_instance_get_name");
		}

		inst_t *i;
		if ((i = insts_lookup(ina)) == NULL) {
			/*
			 * If we discover an instance during the walk which was
			 * not added to the set during the planning phase, it
			 * is surplus to requirements and will be torn down.
			 */
			if (insts_add_unwanted(ina) != 0) {
				err(1, "insts_add_unwanted");
			}

			i = insts_lookup(ina);
		}
		i->inst_exists = true;
	}
	free(ina);
	scf_iter_destroy(i_instance);

	/*
	 * Print out what we have found:
	 */
	printf("--- INSTANCES TO REMOVE\n");
	for (inst_t *i = avl_last(&g_insts); i != NULL;
	    i = AVL_PREV(&g_insts, i)) {
		if (!i->inst_needed && i->inst_exists) {
			printf("\t%s\n", i->inst_name);

			if (remove_instance(smfx, service, i->inst_name) != 0) {
				err(1, "remove_instance");
			}

			i->inst_exists = false;

			printf("\n");
		}
	}

	printf("--- INSTANCE LOAD/CREATE\n");
	for (inst_t *i = avl_first(&g_insts); i != NULL;
	    i = AVL_NEXT(&g_insts, i)) {
		if (i->inst_needed) {
			printf("\t%s\n", i->inst_name);

			if (smfx_ensure_instance(smfx, service, i->inst_name,
			    &i->inst_instance) != 0) {
				errx(1, "ensuring instance \"%s\" exists: %s",
				    i->inst_name, smfx_errmsg(smfx));
			}

			i->inst_exists = true;

			printf("\n");
		}
	}

	printf("--- INSTANCE CONFIGURATION\n");
	for (inst_t *i = avl_first(&g_insts); i != NULL;
	    i = AVL_NEXT(&g_insts, i)) {
		if (i->inst_needed) {
			printf("\t%s\n", i->inst_name);

			/*
			 * Create an nvlist with the full set of properties
			 * that need to be in the "config" property group
			 * for this instance.
			 */
			nvlist_t *targ;
			int r;
			if ((r = nvlist_alloc(&targ, NV_UNIQUE_NAME, 0)) != 0) {
				errno = r;
				err(1, "nvlist_alloc");
			}

			if ((r = nvlist_add_uint64(targ, "instance",
			    i->inst_number)) != 0) {
				errno = r;
				err(1, "nvlist_add_string");
			}

			char buf[PATH_MAX];
			snprintf(buf, sizeof (buf), BINDER_SOCKET_PATH,
			    i->inst_number);
			if ((r = nvlist_add_string(targ, "socket_path", buf)) !=
			    0) {
				errno = r;
				err(1, "nvlist_add_string");
			}

			if (configure_instance(smfx, i->inst_instance,
			    targ) != 0) {
				if (errno == EINVAL) {
					errx(1,
					    "configuring instance \"%s\": %s",
					    i->inst_name, smfx_errmsg(smfx));
				}
				err(1, "configure_instance");
			}

			if (enable_instance(smfx, i->inst_instance,
			    wait_for_start) != 0) {
				if (errno == ETIMEDOUT) {
					errx(1, "timed out enabling instance "
					    "\"%s\"", i->inst_name);
				}
				VERIFY3S(errno, ==, EINVAL);
				errx(1, "enabling instance \"%s\": %s",
				    i->inst_name, smfx_errmsg(smfx));
			}

			nvlist_free(targ);

			printf("\n");
		}
	}

	inst_t *i;
	void *cookie = NULL;
	while ((i = avl_destroy_nodes(&g_insts, &cookie)) != NULL) {
		scf_instance_destroy(i->inst_instance);
		free(i->inst_name);
		free(i->inst_fmri);
		free(i);
	}
	avl_destroy(&g_insts);

	/*
	 * We restart the auxiliary service instance, which is passed as the
	 * argument to the -r option. This should be a full instance FMRI, e.g.:
	 *
	 * svc:/manta/application/metric-ports-updater:default
	 *
	 * The above FMRI is that of the canonical auxiliary service instance
	 * for binder. This instance must be restarted to update the metricPorts
	 * mdata variable when changes are made to the binder instance
	 * configuration via smf_adjust.
	 */
	if (restart_ifmri != NULL) {
		if (smf_restart_instance(restart_ifmri) != 0) {
			fatal_scf("smf_restart_instance");
		}
	}

	smfx_free(smfx);
	return (0);
}
