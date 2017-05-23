#!/bin/bash

# Get environment configuration or use defaults if unavailable.
DB_HOST=${DB_HOST:-localhost}
DB_PORT_5432_TCP_PORT=${DB_PORT_5432_TCP_PORT:-5432}
DB_NAME=${DB_NAME:-catmaid}
DB_USER=${POSTGRES_USER:-catmaid_user}
DB_PASS=${POSTGRES_PASSWORD:-catmaid_password}

TIMEZONE=`readlink /etc/localtime | sed "s/.*\/\(.*\)$/\1/"`

# Check if the first argument begins with a dash. If so, prepend "platform" to
# the list of arguments.
if [ "${1:0:1}" = '-' ]; then
    set -- platform "$@"
fi

if [ "$1" = 'platform' ]; then

    echo "Wait until database $DB_HOST:$DB_PORT_5432_TCP_PORT is ready..."
    until nc -z $DB_HOST $DB_PORT_5432_TCP_PORT
    do
        sleep 1
    done

    # Wait to avoid "panic: Failed to open sql connection pq: the database system is starting up"
    sleep 1

    if [ ! -f /home/django/projects/mysite/settings.py ]; then
      echo "Setting up CATMAID"

      cp /home/django/configuration.py.example /home/django/configuration.py
      sed -i -e "s?^\(abs_catmaid_path = \).*?\1'/home'?g" /home/django/configuration.py
      sed -i -e "s?^\(abs_virtualenv_python_library_path = \).*?\1'/opt/virtualenvs/catmaid/local/lib/python2.7/site-packages'?g" /home/django/configuration.py
      sed -i -e "s?^\(catmaid_database_name = \).*?\1'${DB_NAME}'?g" /home/django/configuration.py
      sed -i -e "s?^\(catmaid_database_username = \).*?\1'${DB_USER}'?g" /home/django/configuration.py
      sed -i -e "s?^\(catmaid_database_password = \).*?\1'${DB_PASS}'?g" /home/django/configuration.py
      sed -i -e "s?^\(catmaid_timezone = \).*?\1'${TIMEZONE}'?g" /home/django/configuration.py
      sed -i -e "s?^\(catmaid_servername = \).*?\1'*'?g" /home/django/configuration.py
      cd /home/django && python create_configuration.py
      mkdir -p /home/django/static

      /home/scripts/createuser.sh ${DB_NAME} ${DB_USER} ${DB_PASS} | psql

      source /usr/share/virtualenvwrapper/virtualenvwrapper.sh
      workon catmaid
      cd /home/django/projects
      python manage.py migrate --noinput
      python manage.py collectstatic --clear --link --noinput
      cat /home/scripts/docker/create_superuser.py | python manage.py shell
      python manage.py catmaid_insert_example_projects --user=1

    fi
    echo "Starting platform"
fi

exec "$@"
