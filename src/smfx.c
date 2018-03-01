
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

#include "utils.h"
#include "nvlist_equal.h"
#include "smfx.h"

struct smfx {
	scf_handle_t *smfx_scf;
	scf_scope_t *smfx_scope;

	scf_error_t smfx_err;
	char smfx_errmsg[SMFX_ERROR_SIZE];
};

scf_handle_t *
smfx_handle(smfx_t *smfx)
{
	return (smfx->smfx_scf);
}

scf_error_t
smfx_scf_error(smfx_t *smfx)
{
	return (smfx->smfx_err);
}

const char *
smfx_errmsg(smfx_t *smfx)
{
	return (smfx->smfx_errmsg);
}

static void
make_errmsg_scf(char *errmsg, const char *func)
{
	if (errmsg == NULL) {
		return;
	}

	(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: %s", func,
	    scf_strerror(scf_error()));
}

static void
make_errmsg_errno(char *errmsg, const char *func, int en)
{
	if (errmsg == NULL) {
		return;
	}

	const char *es = strerror(en);
	if (es == NULL) {
		(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: errno %d",
		    func, en);
	} else {
		(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: %s", func, es);
	}
}

static void
record_scf_error(smfx_t *smfx, const char *func)
{
	make_errmsg_scf(smfx->smfx_errmsg, func);
	smfx->smfx_err = scf_error();
}

static void
record_errno(smfx_t *smfx, const char *func)
{
	make_errmsg_errno(smfx->smfx_errmsg, func, errno);
	smfx->smfx_err = SCF_ERROR_INTERNAL;
}

static void
record_custom_error(smfx_t *smfx, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);

	(void) vsnprintf(smfx->smfx_errmsg, SMFX_ERROR_SIZE, fmt, ap);

	va_end(ap);
}

int
smfx_alloc(smfx_t **smfxp, char *errmsg)
{
	smfx_t *smfx;

	if ((smfx = calloc(1, sizeof (*smfx))) == NULL) {
		make_errmsg_errno(errmsg, "calloc", errno);
		return (-1);
	}
	smfx->smfx_err = SCF_ERROR_NONE;

	if ((smfx->smfx_scf = scf_handle_create(SCF_VERSION)) == NULL) {
		make_errmsg_scf(errmsg, "scf_handle_create");
		free(smfx);
		return (-1);
	}

	if (scf_handle_bind(smfx->smfx_scf) != 0) {
		make_errmsg_scf(errmsg, "scf_handle_bind");
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return (-1);
	}

	if ((smfx->smfx_scope = scf_scope_create(smfx->smfx_scf)) == NULL) {
		make_errmsg_scf(errmsg, "scf_scope_create");
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return (-1);
	}

	if (scf_handle_get_scope(smfx->smfx_scf, SCF_SCOPE_LOCAL,
	    smfx->smfx_scope) != 0) {
		make_errmsg_scf(errmsg, "scf_handle_get_scope");
		scf_scope_destroy(smfx->smfx_scope);
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return(-1);
	}

	*smfxp = smfx;
	return (0);
}

void
smfx_free(smfx_t *smfx)
{
	if (smfx == NULL) {
		return;
	}

	scf_scope_destroy(smfx->smfx_scope);
	scf_handle_destroy(smfx->smfx_scf);
	free(smfx);
}

#if 0
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
#endif

/*
 * Create the "config" property group if it does not exist.  If it does exist,
 * load it.
 */
int
smfx_ensure_pg(smfx_t *smfx, scf_instance_t *i, scf_propertygroup_t **pgp,
    const char *pgname, const char *group_type)
{
	if (pgp != NULL) {
		*pgp = NULL;
	}

	scf_propertygroup_t *pg;
	if ((pg = scf_pg_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_pg_create");
		return (-1);
	}

	/*
	 * Try to add the property group.
	 */
	if (scf_instance_add_pg(i, pgname, group_type, 0, pg) != 0) {
		if (scf_error() != SCF_ERROR_EXISTS) {
			record_scf_error(smfx, "scf_instance_add_pg");
			goto bail;
		}

		if (scf_instance_get_pg(i, pgname, pg) != 0) {
			record_scf_error(smfx, "scf_instance_get_pg");
			goto bail;
		}

		/*
		 * Check to make sure it has the correct type.
		 */
		size_t typesz = scf_limit(SCF_LIMIT_MAX_PG_TYPE_LENGTH) + 1;
		char *type;
		if ((type = malloc(typesz)) == NULL) {
			record_errno(smfx, "malloc (pg type string)");
			goto bail;
		}

		if (scf_pg_get_type(pg, type, typesz) < 0) {
			record_scf_error(smfx, "scf_pg_get_type");
			goto bail;
		}

		if (strcmp(type, group_type) != 0) {
			record_custom_error(smfx, "group \"%s\" has type "
			    "\"%s\", wanted \"%s\"", pgname, type, group_type);
			free(type);
			goto bail;
		}

		free(type);
	}

	if (pgp != NULL) {
		*pgp = pg;
	}
	return (0);

bail:
	scf_pg_destroy(pg);
	return (-1);
}

static int
flush_status(smfx_t *smfx, scf_instance_t *i)
{
	char *fmri;
	if (smfx_instance_fmri(smfx, i, &fmri) != 0) {
		return (-1);
	}

	for (;;) {
		char *st;
		if ((st = smf_get_state(fmri)) != NULL) {
			/*
			 * If we were able to get the service state, everything
			 * is fine.
			 */
			free(st);
			free(fmri);
			return (0);
		}
		free(st);

		if (scf_error() != SCF_ERROR_NOT_FOUND) {
			record_scf_error(smfx, "smf_get_state");
			goto bail;
		}

		/*
		 * Under some conditions a newly created service will not yet
		 * have the property which reflects whether it is enabled or
		 * disabled.  We can force the system to flush out a valid
		 * value by disabling the service.
		 */
		if (smf_refresh_instance(fmri) != 0) {
			record_scf_error(smfx, "smf_refresh_instance");
			goto bail;
		}
		if (smf_disable_instance(fmri, 0) != 0) {
			record_scf_error(smfx, "smf_disable_instance");
			goto bail;
		}

		/*
		 * Sleep for a short period and check again.
		 */
		sleep_ms(10);
		continue;

bail:
		free(st);
		free(fmri);
		return (-1);
	}
}

int
smfx_ensure_instance(smfx_t *smfx, scf_service_t *service, const char *name,
    scf_instance_t **out)
{
	scf_instance_t *i;
	if (smfx_instance_create(smfx, &i) != 0) {
		return (-1);
	}

	if (scf_service_add_instance(service, name, i) != 0) {
		if (scf_error() != SCF_ERROR_EXISTS) {
			record_scf_error(smfx, "scf_service_add_instance");
			scf_instance_destroy(i);
			return (-1);
		}

		/*
		 * The instance exists already, so load it.
		 */
		if (scf_service_get_instance(service, name, i) != 0) {
			record_scf_error(smfx, "scf_service_get_instance");
			scf_instance_destroy(i);
			return (-1);
		}
	}

	/*
	 * Poke the restarter to ensure this service is marked as disabled and
	 * all appropriate properties get created.
	 */
	if (flush_status(smfx, i) != 0) {
		return (-1);
	}

	if (out != NULL) {
		*out = i;
	} else {
		scf_instance_destroy(i);
	}
	return (0);
}


int
smfx_locate_service(smfx_t *smfx, const char *n, scf_service_t **service)
{
	*service = NULL;

	scf_service_t *s;
	if ((s = scf_service_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_service_create");
		return (-1);
	}

	if (scf_handle_decode_fmri(smfx->smfx_scf, n, smfx->smfx_scope, s, NULL,
	    NULL, NULL, SCF_DECODE_FMRI_EXACT) != 0) {
		if (scf_error() == SCF_ERROR_NOT_FOUND) {
			record_custom_error(smfx, "service \"%s\" not found",
			    n);
		} else if (scf_error() == SCF_ERROR_CONSTRAINT_VIOLATED) {
			record_custom_error(smfx, "\"%s\" is not a valid SMF "
			    "service FMRI", n);
		} else {
			record_scf_error(smfx, "scf_handle_decode_fmri");
		}

		scf_service_destroy(s);
		return (-1);
	}

	*service = s;
	return (0);
}

int
smfx_instance_fmri(smfx_t *smfx, scf_instance_t *i, char **fmri)
{
	ssize_t sz;
	if ((sz = scf_instance_to_fmri(i, NULL, 0)) < 0) {
		record_scf_error(smfx, "scf_instance_to_fmri");
		return (-1);
	}

	char *t;
	if ((t = malloc(sz + 1)) == NULL) {
		record_errno(smfx, "malloc (fmri string)");
		return (-1);
	}

	if (scf_instance_to_fmri(i, t, sz + 1) < 0) {
		record_scf_error(smfx, "scf_instance_to_fmri");
	}

	*fmri = t;
	return (0);
}

int
smfx_load_instance(smfx_t *smfx, scf_service_t *service, const char *name,
    scf_instance_t **out)
{
	scf_instance_t *i;
	if (smfx_instance_create(smfx, &i) != 0) {
		return (-1);
	}

	if (scf_service_get_instance(service, name, i) != 0) {
		record_scf_error(smfx, "scf_service_get_instance");
		scf_instance_destroy(i);
		return (-1);
	}

	*out = i;
	return (0);
}

int
smfx_load_snapshot(smfx_t *smfx, scf_instance_t *i, const char *name,
    scf_snapshot_t **snapp)
{
	scf_snapshot_t *snap;
	if ((snap = scf_snapshot_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_create_snapshot");
		return (-1);
	}

	if (scf_instance_get_snapshot(i, name, snap) != 0) {
		record_scf_error(smfx, "scf_instance_get_snapshot");
		scf_snapshot_destroy(snap);
		return (-1);
	}

	*snapp = snap;
	return (0);
}

int
smfx_instance_create(smfx_t *smfx, scf_instance_t **out)
{
	*out = NULL;

	scf_instance_t *i;
	if ((i = scf_instance_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_instance_create");
		return (-1);
	}

	*out = i;
	return (0);
}

#if 0
static int
remove_instance(scf_service_t *service, inst_t *inst)
{
	scf_handle_t *scf = scf_service_handle(service);

	scf_instance_t *i;
	if ((i = scf_instance_create(scf)) == NULL) {
		fatal_scf("scf_instance_create");
	}

	if (scf_service_get_instance(service, inst->inst_name, i) != 0) {
		fatal_scf("scf_service_get_instance");
	}

	/*
	 * Determine the full FMRI for this instance.
	 */
	char *fmri;
	if (instance_fmri(i, &fmri) != 0) {
		scf_instance_destroy(i);
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
	inst->inst_exists = false;

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
refresh_instance(scf_instance_t *i)
{
	char *fmri;
	if (instance_fmri(i, &fmri) != 0) {
		scf_instance_destroy(i);
		return (-1);
	}

	if (smf_refresh_instance(fmri) != 0) {
		fatal_scf("smf_disable_instance");
	}

	free(fmri);
	return (0);
}

static int
configure_instance(scf_instance_t *i, nvlist_t *targ)
{
	scf_handle_t *scf = scf_instance_handle(i);
	nvlist_t *current = NULL, *fromsnap = NULL;
	scf_propertygroup_t *pg = NULL, *cpg = NULL;

	/*
	 * Ensure that the property group exists and obtain a reference to it.
	 */
	if (ensure_pg(i, &pg, "config", SCF_GROUP_APPLICATION) != 0) {
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

	if (load_snapshot(i, SCF_SNAPSHOT_RUNNING, &snap) != 0) {
		VERIFY3S(errno, ==, ENOENT);

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
		refresh_instance(i);
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
enable_instance(scf_instance_t *i)
{
	char *fmri;
	if (instance_fmri(i, &fmri) != 0) {
		err(1, "instance_fmri");
	}

	hrtime_t start = gethrtime();

	for (;;) {
		char *st;

		if ((st = smf_get_state(fmri)) == NULL) {
			fatal_scf("smf_get_state");
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

		} else if (strcmp(st, SCF_STATE_STRING_ONLINE) == 0) {
			/*
			 * We're finished!
			 */
			break;

		} else if (strcmp(st, SCF_STATE_STRING_DISABLED) == 0) {
			/*
			 * The service is disabled.  Refresh the instance to
			 * ensure visibility of the latest property group
			 * changes, and then enable the instance.
			 */
			if (smf_refresh_instance(fmri) != 0) {
				fatal_scf("smf_restore_instance");
			}
			if (smf_enable_instance(fmri, 0) != 0) {
				fatal_scf("smf_restore_instance");
			}
		}

		/*
		 * Don't wait more than 60 seconds for this situation to correct
		 * itself.
		 */
		hrtime_t duration = gethrtime() - start;
		if (duration > SEC2NSEC(60)) {
			free(fmri);
			errno = ETIMEDOUT;
			return (-1);
		}
		
		sleep_ms(100);
	}

	free(fmri);
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
#endif
