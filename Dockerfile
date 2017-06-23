FROM ubuntu:16.04
MAINTAINER Andrew Champion "andrew.champion@gmail.com"

# Install dependencies
RUN apt-get update -y \
    && apt-get install -y netcat \
    && apt-get install -y python-pip git \
    && apt-get install -y supervisor uwsgi-plugin-python
ADD packagelist-ubuntu-16.04-apt.txt /home/
RUN xargs apt-get install -y < /home/packagelist-ubuntu-16.04-apt.txt
ADD django/requirements.txt /home/django/
ENV WORKON_HOME /opt/virtualenvs
RUN mkdir -p /opt/virtualenvs \
    && /bin/bash -c "source /usr/share/virtualenvwrapper/virtualenvwrapper.sh \
    && mkvirtualenv catmaid \
    && workon catmaid \
    && pip install -U pip \
    && pip install -r /home/django/requirements.txt"

ADD . /home/

# nginx and uWSGI setup
RUN pip install uwsgi \
    && ln -s /home/scripts/docker/supervisor-catmaid.conf /etc/supervisor/conf.d/ \
    && chmod +x /home/scripts/docker/start-catmaid.sh \
    && chmod +x /home/scripts/docker/catmaid-entry.sh

ENTRYPOINT ["/home/scripts/docker/catmaid-entry.sh"]

EXPOSE 8000
WORKDIR /home/django/projects/mysite
CMD ["platform"]
